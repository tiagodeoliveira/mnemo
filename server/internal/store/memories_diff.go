package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// UpdateOp is an update operation in a MemoryDiff.
type UpdateOp struct {
	ID      uuid.UUID `json:"id"`
	Content string    `json:"content"`
	Tags    []string  `json:"tags"`
}

// InsertOp is an insert operation in a MemoryDiff.
type InsertOp struct {
	Content string   `json:"content"`
	Tags    []string `json:"tags"`
}

// MemoryDiff is the consolidated diff returned by the LLM and applied to the store.
type MemoryDiff struct {
	Keep      []uuid.UUID `json:"keep"`
	Reinforce []uuid.UUID `json:"reinforce"`
	Delete    []uuid.UUID `json:"delete"`
	Update    []UpdateOp  `json:"update"`
	Insert    []InsertOp  `json:"insert"`
}

// DiffApplyOpts carries dimension-level context for applying a diff.
type DiffApplyOpts struct {
	ActorID       string
	Dimension     string
	Namespace     string
	SourceEventID uuid.UUID
	// TTLDays: 0 = never expires. Otherwise expires_at = now() + TTLDays.
	TTLDays int
}

// ApplyMemoryDiff validates the diff against existing items (re-queried inside
// the tx for race safety) and applies all operations atomically.
func (s *Store) ApplyMemoryDiff(
	ctx context.Context,
	tx *sql.Tx,
	opts DiffApplyOpts,
	diff MemoryDiff,
) error {
	// Re-query existing items for race safety.
	rows, err := tx.QueryContext(ctx, `
		SELECT memory_id FROM memories
		 WHERE actor_id = $1 AND namespace = $2
		   FOR UPDATE
	`, opts.ActorID, opts.Namespace)
	if err != nil {
		return fmt.Errorf("ApplyMemoryDiff: re-query existing: %w", err)
	}
	existingSet := make(map[uuid.UUID]bool)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		existingSet[id] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}

	// Validate IDs in diff against the re-queried set.
	checkID := func(id uuid.UUID, op string) error {
		if !existingSet[id] {
			return fmt.Errorf("ApplyMemoryDiff: ID %s in %s not found in namespace %s", id, op, opts.Namespace)
		}
		return nil
	}

	for _, id := range diff.Keep {
		if err := checkID(id, "keep"); err != nil {
			return err
		}
	}
	for _, id := range diff.Reinforce {
		if err := checkID(id, "reinforce"); err != nil {
			return err
		}
	}
	for _, id := range diff.Delete {
		if err := checkID(id, "delete"); err != nil {
			return err
		}
	}
	for _, op := range diff.Update {
		if err := checkID(op.ID, "update"); err != nil {
			return err
		}
	}

	now := time.Now().UTC()
	newExpiresAt := expiresAtFromTTL(now, opts.TTLDays)

	// keep: no SQL action.

	// reinforce: bump updated_at, expires_at, reinforced_count, source_event_ids.
	for _, id := range diff.Reinforce {
		var q string
		var args []any
		if newExpiresAt != nil {
			q = `UPDATE memories
			     SET reinforced_count = reinforced_count + 1,
			         updated_at       = $2,
			         expires_at       = $3,
			         source_event_ids = array_append(source_event_ids, $4::uuid)
			   WHERE memory_id = $1`
			args = []any{id, now, *newExpiresAt, opts.SourceEventID}
		} else {
			q = `UPDATE memories
			     SET reinforced_count = reinforced_count + 1,
			         updated_at       = $2,
			         expires_at       = NULL,
			         source_event_ids = array_append(source_event_ids, $3::uuid)
			   WHERE memory_id = $1`
			args = []any{id, now, opts.SourceEventID}
		}
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return fmt.Errorf("ApplyMemoryDiff reinforce %s: %w", id, err)
		}
	}

	// update: set content+tags, bump updated_at, expires_at, source_event_ids.
	for _, op := range diff.Update {
		tagsJSON := tagsToJSON(op.Tags)
		var q string
		var args []any
		if newExpiresAt != nil {
			q = `UPDATE memories
			     SET content          = $2,
			         tags             = $3,
			         updated_at       = $4,
			         expires_at       = $5,
			         source_event_ids = array_append(source_event_ids, $6::uuid)
			   WHERE memory_id = $1`
			args = []any{op.ID, op.Content, tagsJSON, now, *newExpiresAt, opts.SourceEventID}
		} else {
			q = `UPDATE memories
			     SET content          = $2,
			         tags             = $3,
			         updated_at       = $4,
			         expires_at       = NULL,
			         source_event_ids = array_append(source_event_ids, $5::uuid)
			   WHERE memory_id = $1`
			args = []any{op.ID, op.Content, tagsJSON, now, opts.SourceEventID}
		}
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return fmt.Errorf("ApplyMemoryDiff update %s: %w", op.ID, err)
		}
	}

	// delete: hard delete.
	for _, id := range diff.Delete {
		if _, err := tx.ExecContext(ctx, `DELETE FROM memories WHERE memory_id = $1`, id); err != nil {
			return fmt.Errorf("ApplyMemoryDiff delete %s: %w", id, err)
		}
	}

	// insert: new rows.
	for _, op := range diff.Insert {
		id := uuid.New()
		tagsJSON := tagsToJSON(op.Tags)
		var expiresVal interface{}
		if newExpiresAt != nil {
			expiresVal = *newExpiresAt
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO memories (
				memory_id, actor_id, dimension, namespace, content,
				tags, attributes, source_event_ids, reinforced_count,
				created_at, updated_at, expires_at
			) VALUES ($1, $2, $3, $4, $5, $6, '{}', ARRAY[$7::uuid], 1, $8, $8, $9)
		`, id, opts.ActorID, opts.Dimension, opts.Namespace, op.Content,
			tagsJSON, opts.SourceEventID, now, expiresVal)
		if err != nil {
			return fmt.Errorf("ApplyMemoryDiff insert: %w", err)
		}
	}

	return nil
}

func expiresAtFromTTL(now time.Time, days int) *time.Time {
	if days <= 0 {
		return nil
	}
	t := now.Add(time.Duration(days) * 24 * time.Hour)
	return &t
}

func tagsToJSON(tags []string) []byte {
	if len(tags) == 0 {
		return []byte("[]")
	}
	out := []byte{'['}
	for i, t := range tags {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, '"')
		out = append(out, []byte(t)...)
		out = append(out, '"')
	}
	out = append(out, ']')
	return out
}
