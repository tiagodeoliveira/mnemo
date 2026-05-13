package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Memory struct {
	ID         uuid.UUID
	ActorID    string
	Dimension  string
	Namespace  string
	Content    string
	Attributes json.RawMessage
	UpdatedAt  time.Time
}

type MemoryInput struct {
	ActorID       string
	Dimension     string
	Namespace     string
	Content       string
	Attributes    json.RawMessage
	SourceEventID *uuid.UUID
}

// InsertAppendMemory inserts a row (no upsert). Caller is responsible for de-dup if needed.
func (s *Store) InsertAppendMemory(ctx context.Context, tx *sql.Tx, m MemoryInput) error {
	attrs := m.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO memories (memory_id, actor_id, dimension, namespace, content, attributes, source_event_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, uuid.New(), m.ActorID, m.Dimension, m.Namespace, m.Content, attrs, m.SourceEventID)
	return err
}

// UpsertConsolidatedMemory inserts-or-updates by (actor_id, namespace). Use only for
// dimensions in the consolidated set (enforced by the partial unique index).
func (s *Store) UpsertConsolidatedMemory(ctx context.Context, tx *sql.Tx, m MemoryInput) error {
	attrs := m.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO memories (memory_id, actor_id, dimension, namespace, content, attributes, source_event_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (actor_id, namespace)
		WHERE dimension IN ('about','project','task','daily_summary','meeting')
		DO UPDATE SET content = EXCLUDED.content,
		              attributes = EXCLUDED.attributes,
		              source_event_id = EXCLUDED.source_event_id,
		              updated_at = now()
	`, uuid.New(), m.ActorID, m.Dimension, m.Namespace, m.Content, attrs, m.SourceEventID)
	return err
}

// DeleteAppendMemoriesForEvent removes prior append-dim writes for an event.
// Used by extract_context retries to guarantee idempotency.
func (s *Store) DeleteAppendMemoriesForEvent(ctx context.Context, tx *sql.Tx, actor string, eventID uuid.UUID, dims []string) error {
	if len(dims) == 0 {
		return nil
	}
	args := []any{actor, eventID}
	placeholders := make([]string, len(dims))
	for i, d := range dims {
		placeholders[i] = fmt.Sprintf("$%d", i+3)
		args = append(args, d)
	}
	q := fmt.Sprintf(`
		DELETE FROM memories
		 WHERE actor_id = $1 AND source_event_id = $2 AND dimension IN (%s)
	`, strings.Join(placeholders, ","))
	_, err := tx.ExecContext(ctx, q, args...)
	return err
}

type RecallFilter struct {
	ActorID       string
	NamespacePref string            // namespace prefix
	AttrFilters   map[string]string // attributes->>k = v
	Limit         int
}

// QueryByPrefix returns memories whose namespace starts with prefix, ordered newest first.
func (s *Store) QueryByPrefix(ctx context.Context, f RecallFilter) ([]Memory, error) {
	args := []any{f.ActorID, f.NamespacePref + "%"}
	clauses := []string{"actor_id = $1", "namespace LIKE $2"}
	i := 3
	for k, v := range f.AttrFilters {
		clauses = append(clauses, fmt.Sprintf("attributes->>$%d = $%d", i, i+1))
		args = append(args, k, v)
		i += 2
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	q := fmt.Sprintf(`
		SELECT memory_id, actor_id, dimension, namespace, content, attributes, updated_at
		  FROM memories
		 WHERE %s
		 ORDER BY updated_at DESC
		 LIMIT %d
	`, strings.Join(clauses, " AND "), limit)
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Memory
	for rows.Next() {
		var m Memory
		if err := rows.Scan(&m.ID, &m.ActorID, &m.Dimension, &m.Namespace, &m.Content, &m.Attributes, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
