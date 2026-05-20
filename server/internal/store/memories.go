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

// Memory is the read-side representation of a memory item row.
type Memory struct {
	ID              uuid.UUID
	ActorID         string
	Dimension       string
	Namespace       string
	Content         string
	Tags            []string
	Attributes      json.RawMessage
	SourceEventIDs  []uuid.UUID
	ReinforcedCount int
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ExpiresAt       sql.NullTime
	// Embedding is intentionally not exposed; not needed for non-search reads.
}

// ItemInput is the canonical write-side input for inserting a new item.
type ItemInput struct {
	ActorID       string
	Dimension     string
	Namespace     string
	Content       string
	Tags          []string
	Attributes    json.RawMessage
	SourceEventID uuid.UUID
	ExpiresAt     sql.NullTime
	Embedding     []float32 // optional; nil means embedding column stays NULL
}

// InsertItem writes a new memory item row. If in.Embedding is non-nil, it is
// written to the embedding column; otherwise embedding stays NULL and the
// backfill job will populate it later.
func (s *Store) InsertItem(ctx context.Context, tx *sql.Tx, in ItemInput) (uuid.UUID, error) {
	id := uuid.New()
	attrs := in.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}
	tags, err := json.Marshal(in.Tags)
	if err != nil {
		return uuid.UUID{}, err
	}

	var expiresAt interface{}
	if in.ExpiresAt.Valid {
		expiresAt = in.ExpiresAt.Time
	}

	var embVal interface{}
	if in.Embedding != nil {
		embVal = pgvector.NewVector(in.Embedding)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO memories (
			memory_id, actor_id, dimension, namespace, content,
			tags, attributes, source_event_ids, reinforced_count,
			expires_at, embedding
		) VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[$8::uuid], 1, $9, $10)
	`, id, in.ActorID, in.Dimension, in.Namespace, in.Content,
		tags, attrs, in.SourceEventID, expiresAt, embVal)
	return id, err
}

// ListItemsByNamespace returns all items in a namespace, oldest first.
func (s *Store) ListItemsByNamespace(ctx context.Context, actorID, namespace string) ([]Memory, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT memory_id, actor_id, dimension, namespace, content,
		       tags, attributes, source_event_ids, reinforced_count,
		       created_at, updated_at, expires_at
		  FROM memories
		 WHERE actor_id = $1 AND namespace = $2
		 ORDER BY created_at ASC
	`, actorID, namespace)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	return scanMemories(rows)
}

// ListItemsOpts are the options for ListItems.
type ListItemsOpts struct {
	ActorID         string
	Dimension       string   // optional
	NamespacePrefix string   // optional
	Tags            []string // optional, OR semantics
	TagsAll         []string // optional, AND semantics
	Since           sql.NullTime
	Until           sql.NullTime
	Limit           int // default 100
}

// ListItems is the general-purpose recall query.
func (s *Store) ListItems(ctx context.Context, opts ListItemsOpts) ([]Memory, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}

	clauses := []string{"actor_id = $1"}
	args := []any{opts.ActorID}
	i := 2

	if opts.Dimension != "" {
		clauses = append(clauses, fmt.Sprintf("dimension = $%d", i))
		args = append(args, opts.Dimension)
		i++
	}
	if opts.NamespacePrefix != "" {
		clauses = append(clauses, fmt.Sprintf("namespace LIKE $%d", i))
		args = append(args, opts.NamespacePrefix+"%")
		i++
	}
	if len(opts.Tags) > 0 {
		tagsJSON, _ := json.Marshal(opts.Tags)
		clauses = append(clauses, fmt.Sprintf("tags ?| $%d::jsonb", i))
		args = append(args, string(tagsJSON))
		i++
	}
	if len(opts.TagsAll) > 0 {
		tagsJSON, _ := json.Marshal(opts.TagsAll)
		clauses = append(clauses, fmt.Sprintf("tags @> $%d", i))
		args = append(args, string(tagsJSON))
		i++
	}
	if opts.Since.Valid {
		clauses = append(clauses, fmt.Sprintf("updated_at >= $%d", i))
		args = append(args, opts.Since.Time)
		i++
	}
	if opts.Until.Valid {
		clauses = append(clauses, fmt.Sprintf("updated_at <= $%d", i))
		args = append(args, opts.Until.Time)
	}

	q := fmt.Sprintf(`
		SELECT memory_id, actor_id, dimension, namespace, content,
		       tags, attributes, source_event_ids, reinforced_count,
		       created_at, updated_at, expires_at
		  FROM memories
		 WHERE %s
		 ORDER BY updated_at DESC
		 LIMIT %d
	`, strings.Join(clauses, " AND "), limit)

	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	return scanMemories(rows)
}

// DeleteAppendItemsForEvent removes prior append-dim writes for an event.
// Used by extract_context retries to guarantee idempotency.
func (s *Store) DeleteAppendItemsForEvent(ctx context.Context, tx *sql.Tx, eventID uuid.UUID, dims []string) error {
	if len(dims) == 0 {
		return nil
	}
	placeholders := make([]string, len(dims))
	args := []any{eventID}
	for i, d := range dims {
		placeholders[i] = fmt.Sprintf("$%d", i+2)
		args = append(args, d)
	}
	q := fmt.Sprintf(`
		DELETE FROM memories
		 WHERE $1 = ANY(source_event_ids) AND dimension IN (%s)
	`, strings.Join(placeholders, ","))
	_, err := tx.ExecContext(ctx, q, args...)
	return err
}

// ReplaceItemByNamespace deletes any prior row at (actor, namespace) and
// inserts a fresh one. Use for single-row-per-namespace dimensions
// (daily_summary, per-meeting categories) where each write supersedes the
// previous content for that namespace.
func (s *Store) ReplaceItemByNamespace(ctx context.Context, tx *sql.Tx, in ItemInput) error {
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM memories WHERE actor_id=$1 AND namespace=$2`,
		in.ActorID, in.Namespace); err != nil {
		return err
	}
	_, err := s.InsertItem(ctx, tx, in)
	return err
}

// scanMemories scans a result-set into []Memory.
func scanMemories(rows *sql.Rows) ([]Memory, error) {
	var out []Memory
	for rows.Next() {
		var m Memory
		var tagsRaw []byte
		var sourceEventIDsStr []string
		var expiresAt sql.NullTime

		if err := rows.Scan(
			&m.ID, &m.ActorID, &m.Dimension, &m.Namespace, &m.Content,
			&tagsRaw, &m.Attributes, pq.Array(&sourceEventIDsStr), &m.ReinforcedCount,
			&m.CreatedAt, &m.UpdatedAt, &expiresAt,
		); err != nil {
			return nil, err
		}

		// Parse tags JSON.
		if len(tagsRaw) > 0 {
			_ = json.Unmarshal(tagsRaw, &m.Tags)
		}
		if m.Tags == nil {
			m.Tags = []string{}
		}

		// Parse source_event_ids strings to uuid.UUID.
		m.SourceEventIDs = make([]uuid.UUID, 0, len(sourceEventIDsStr))
		for _, s := range sourceEventIDsStr {
			id, err := uuid.Parse(s)
			if err == nil {
				m.SourceEventIDs = append(m.SourceEventIDs, id)
			}
		}

		m.ExpiresAt = expiresAt
		out = append(out, m)
	}
	return out, rows.Err()
}
