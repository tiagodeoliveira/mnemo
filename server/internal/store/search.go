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
	QueryEmbedding  []float32
	Dimensions      []string     // optional; nil = all dimensions
	NamespacePrefix string       // optional
	Tags            []string     // optional, OR semantics
	TagsAll         []string     // optional, AND semantics
	Since           sql.NullTime
	Until           sql.NullTime
	Limit           int     // default 50, max 200
	MinSimilarity   float32 // 0 = no threshold
}

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

// SemanticSearch runs the cosine-similarity query with all filters.
func (s *Store) SemanticSearch(ctx context.Context, opts SearchOpts) ([]SearchHit, error) {
	if len(opts.QueryEmbedding) == 0 {
		return nil, fmt.Errorf("search: empty query embedding")
	}
	if opts.Limit <= 0 {
		opts.Limit = 50
	} else if opts.Limit > 200 {
		opts.Limit = 200
	}

	// $1 = actor_id, $2 = query vector
	args := []any{opts.ActorID, pgvector.NewVector(opts.QueryEmbedding)}
	clauses := []string{"actor_id = $1", "embedding IS NOT NULL"}

	// Dynamic placeholder index starts at 3 because $1 and $2 are already used.
	idx := 3
	addArg := func(v any) string {
		ph := fmt.Sprintf("$%d", idx)
		args = append(args, v)
		idx++
		return ph
	}

	if len(opts.Dimensions) > 0 {
		clauses = append(clauses, "dimension = ANY("+addArg(opts.Dimensions)+")")
	}
	if opts.NamespacePrefix != "" {
		clauses = append(clauses, "namespace LIKE "+addArg(opts.NamespacePrefix+"%"))
	}
	if len(opts.Tags) > 0 {
		// tags ?| text[] — OR semantics: does the jsonb array contain any of these strings?
		clauses = append(clauses, "tags ?| "+addArg(pq.Array(opts.Tags)))
	}
	if len(opts.TagsAll) > 0 {
		// tags @> '["a","b"]'::jsonb — AND semantics
		tagsJSON, _ := json.Marshal(opts.TagsAll)
		clauses = append(clauses, "tags @> "+addArg(string(tagsJSON))+"::jsonb")
	}
	if opts.Since.Valid {
		clauses = append(clauses, "updated_at >= "+addArg(opts.Since.Time))
	}
	if opts.Until.Valid {
		clauses = append(clauses, "updated_at <= "+addArg(opts.Until.Time))
	}
	if opts.MinSimilarity > 0 {
		clauses = append(clauses, "1 - (embedding <=> $2) >= "+addArg(opts.MinSimilarity))
	}

	q := fmt.Sprintf(`
		SELECT memory_id, dimension, namespace, content, tags,
		       created_at, updated_at, reinforced_count,
		       1 - (embedding <=> $2) AS similarity
		  FROM memories
		 WHERE %s
		 ORDER BY embedding <=> $2
		 LIMIT %d
	`, strings.Join(clauses, " AND "), opts.Limit)

	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

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
