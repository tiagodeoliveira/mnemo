package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/pgvector/pgvector-go"
)

// SearchOpts is the cross-cutting input for semantic search. Used by both
// POST /search and ?q= on GET /recall.
type SearchOpts struct {
	ActorID         string
	QueryText       string // raw user query; when non-empty enables BM25 + vector hybrid
	QueryEmbedding  []float32
	Dimensions      []string // optional; nil = all dimensions
	NamespacePrefix string   // optional
	Tags            []string // optional, OR semantics
	TagsAll         []string // optional, AND semantics
	Since           sql.NullTime
	Until           sql.NullTime
	Limit           int     // default 50, max 200
	MinSimilarity   float32 // 0 = no threshold (applies to vector similarity only)
}

// rrfK is the rank-fusion smoothing constant. The standard value from the
// 2009 Cormack/Clarke/Buettcher paper is 60 — large enough that the top few
// ranks dominate without letting position 1 win every fight on its own.
const rrfK = 60

// reinforceBoostWeight controls how strongly reinforced_count shapes the
// final ranking. The boost factor is (1 + weight * ln(1 + reinforced_count)),
// so weight=0.2 turns a 1×-reinforced row into 1.0×, 5×→ 1.36×, 20×→ 1.61×,
// 100× → 1.92×. Small enough that a fresh-but-relevant item can still beat
// a stale-but-popular one; large enough to break ties in favor of conviction.
const reinforceBoostWeight = 0.2

// SearchHit is one result row.
type SearchHit struct {
	ID              uuid.UUID
	Dimension       string
	Namespace       string
	Content         string
	Tags            []string
	Similarity      float32
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ReinforcedCount int
}

// SemanticSearch ranks memories by a hybrid of vector ANN and BM25-style FTS
// (reciprocal rank fusion) when QueryText is provided. Falls back to
// vector-only when QueryText is empty — preserves the original behavior for
// callers that don't have the raw text.
//
// The hybrid path runs each retrieval as its own CTE, takes a candidate pool
// from each, fuses them with RRF, and returns the top-N by fused score. Code
// symbols and exact terms ("pg_try_advisory_lock", "LLMBreaker") survive the
// FTS path that pure embeddings flatten; semantic neighbours survive the
// vector path that FTS misses on synonyms.
func (s *Store) SemanticSearch(ctx context.Context, opts SearchOpts) ([]SearchHit, error) {
	if len(opts.QueryEmbedding) == 0 {
		return nil, fmt.Errorf("search: empty query embedding")
	}
	if opts.Limit <= 0 {
		opts.Limit = 50
	} else if opts.Limit > 200 {
		opts.Limit = 200
	}

	// Build the shared WHERE-clause body. Both CTEs see the same filters so
	// they're computing rankings over the same eligible row set.
	// $1 = actor_id, $2 = query vector. $3 = query text (when hybrid).
	args := []any{opts.ActorID, pgvector.NewVector(opts.QueryEmbedding)}
	idx := 3

	queryText := strings.TrimSpace(opts.QueryText)
	hybrid := queryText != ""
	var queryTextPlaceholder string
	if hybrid {
		args = append(args, queryText)
		queryTextPlaceholder = "$3"
		idx = 4
	}

	addArg := func(v any) string {
		ph := fmt.Sprintf("$%d", idx)
		args = append(args, v)
		idx++
		return ph
	}

	clauses := []string{"actor_id = $1"}

	// Exclude expired rows from recall. expires_at is enforced lazily here (and
	// by the background expiry sweep) so a decayed one-off fact stops surfacing
	// immediately, before the sweep deletes it. NULL = never expires.
	clauses = append(clauses, "(expires_at IS NULL OR expires_at > now())")

	if len(opts.Dimensions) > 0 {
		clauses = append(clauses, "dimension = ANY("+addArg(opts.Dimensions)+")")
	}
	if opts.NamespacePrefix != "" {
		clauses = append(clauses, "namespace LIKE "+addArg(opts.NamespacePrefix+"%"))
	}
	if len(opts.Tags) > 0 {
		clauses = append(clauses, "tags ?| "+addArg(pq.Array(opts.Tags)))
	}
	if len(opts.TagsAll) > 0 {
		tagsJSON, _ := json.Marshal(opts.TagsAll)
		clauses = append(clauses, "tags @> "+addArg(string(tagsJSON))+"::jsonb")
	}
	if opts.Since.Valid {
		clauses = append(clauses, "updated_at >= "+addArg(opts.Since.Time))
	}
	if opts.Until.Valid {
		clauses = append(clauses, "updated_at <= "+addArg(opts.Until.Time))
	}
	filterClause := strings.Join(clauses, " AND ")

	// MinSimilarity is enforced AFTER ranking, against the cosine score only —
	// not against the RRF fused score. The user's intent is "don't show me
	// semantically distant rows," which is well-defined on vector similarity.
	minSim := opts.MinSimilarity

	// Vector candidate pool grows with requested limit so RRF has room to mix.
	candidateLimit := opts.Limit * 4
	if candidateLimit < 100 {
		candidateLimit = 100
	}

	var q string
	if hybrid {
		vecMinSimClause := ""
		if minSim > 0 {
			vecMinSimClause = " AND 1 - (embedding <=> $2) >= " + addArg(minSim)
		}
		q = fmt.Sprintf(`
			WITH
			vec AS (
				SELECT memory_id,
				       ROW_NUMBER() OVER (ORDER BY embedding <=> $2) AS rank,
				       1 - (embedding <=> $2) AS similarity
				  FROM memories
				 WHERE %s AND embedding IS NOT NULL%s
				 ORDER BY embedding <=> $2
				 LIMIT %d
			),
			fts AS (
				SELECT memory_id,
				       ROW_NUMBER() OVER (
				           ORDER BY ts_rank(to_tsvector('simple', content),
				                            plainto_tsquery('simple', %s)) DESC
				       ) AS rank
				  FROM memories
				 WHERE %s AND to_tsvector('simple', content) @@ plainto_tsquery('simple', %s)
				 ORDER BY ts_rank(to_tsvector('simple', content),
				                  plainto_tsquery('simple', %s)) DESC
				 LIMIT %d
			),
			fused AS (
				SELECT COALESCE(vec.memory_id, fts.memory_id) AS memory_id,
				       COALESCE(1.0 / (%d + vec.rank::float), 0) +
				       COALESCE(1.0 / (%d + fts.rank::float), 0) AS rrf_score,
				       COALESCE(vec.similarity, 0) AS similarity
				  FROM vec FULL OUTER JOIN fts USING (memory_id)
			)
			SELECT m.memory_id, m.dimension, m.namespace, m.content, m.tags,
			       m.created_at, m.updated_at, m.reinforced_count,
			       fused.similarity
			  FROM fused
			  JOIN memories m USING (memory_id)
			 ORDER BY fused.rrf_score * (1 + %g * ln(1 + m.reinforced_count)) DESC
			 LIMIT %d
		`, filterClause, vecMinSimClause, candidateLimit,
			queryTextPlaceholder, filterClause, queryTextPlaceholder, queryTextPlaceholder, candidateLimit,
			rrfK, rrfK, reinforceBoostWeight, opts.Limit)
	} else {
		clauses = append(clauses, "embedding IS NOT NULL")
		if minSim > 0 {
			clauses = append(clauses, "1 - (embedding <=> $2) >= "+addArg(minSim))
		}
		// Vector-only path: cosine similarity boosted by reinforcement count.
		// Equivalent to ORDER BY similarity * (1 + w·ln(1+count)) but written
		// directly against the operator so the planner can still use the HNSW
		// index for the initial neighbourhood, then re-sort the small candidate
		// set in memory.
		q = fmt.Sprintf(`
			SELECT memory_id, dimension, namespace, content, tags,
			       created_at, updated_at, reinforced_count,
			       1 - (embedding <=> $2) AS similarity
			  FROM memories
			 WHERE %s
			 ORDER BY (1 - (embedding <=> $2)) * (1 + %g * ln(1 + reinforced_count)) DESC
			 LIMIT %d
		`, strings.Join(clauses, " AND "), reinforceBoostWeight, opts.Limit)
	}

	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var hits []SearchHit
	for rows.Next() {
		var h SearchHit
		var tagsJSON []byte
		if err := rows.Scan(&h.ID, &h.Dimension, &h.Namespace, &h.Content, &tagsJSON,
			&h.CreatedAt, &h.UpdatedAt, &h.ReinforcedCount, &h.Similarity); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(tagsJSON, &h.Tags)
		if h.Tags == nil {
			h.Tags = []string{}
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}
