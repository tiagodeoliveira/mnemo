package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
)

// UpdateOp is an update operation in a MemoryDiff.
type UpdateOp struct {
	ID        uuid.UUID `json:"id"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags"`
	Embedding []float32 `json:"-"` // populated by handler when content changes
}

// InsertOp is an insert operation in a MemoryDiff.
type InsertOp struct {
	Content   string    `json:"content"`
	Tags      []string  `json:"tags"`
	Embedding []float32 `json:"-"` // populated by handler, not LLM
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

// ResolveReport counts how many operations were dropped during diff resolution.
type ResolveReport struct {
	OverlapKeepReinforce   int
	OverlapKeepUpdate      int
	OverlapKeepDelete      int
	OverlapReinforceUpdate int
	OverlapReinforceDelete int
	OverlapUpdateDelete    int
	HallucinatedKeep       int
	HallucinatedReinforce  int
	HallucinatedUpdate     int
	HallucinatedDelete     int
	EmptyInsert            int
}

// Total returns the total count of resolved (dropped) operations.
func (r ResolveReport) Total() int {
	return r.OverlapKeepReinforce + r.OverlapKeepUpdate + r.OverlapKeepDelete +
		r.OverlapReinforceUpdate + r.OverlapReinforceDelete + r.OverlapUpdateDelete +
		r.HallucinatedKeep + r.HallucinatedReinforce + r.HallucinatedUpdate + r.HallucinatedDelete +
		r.EmptyInsert
}

// IsEmpty returns true when no operations were dropped.
func (r ResolveReport) IsEmpty() bool { return r.Total() == 0 }

// resolveAndValidateDiff mutates the LLM-returned diff into a canonical, self-consistent
// form. Returns the cleaned diff + a report of what was resolved.
// Resolution rules (precedence: delete > update > reinforce > keep):
//
//	keep ∩ X → drop from keep (X wins)
//	reinforce ∩ {update, delete} → drop from reinforce
//	update ∩ delete → drop from update
//	hallucinated IDs in any set → drop
//	empty inserts → drop
func resolveAndValidateDiff(d MemoryDiff, valid map[uuid.UUID]bool) (MemoryDiff, ResolveReport) {
	var rep ResolveReport

	// Build high-precedence sets for overlap detection.
	updateIDs := make(map[uuid.UUID]bool, len(d.Update))
	for _, op := range d.Update {
		updateIDs[op.ID] = true
	}
	deleteIDs := make(map[uuid.UUID]bool, len(d.Delete))
	for _, id := range d.Delete {
		deleteIDs[id] = true
	}
	reinforceIDs := make(map[uuid.UUID]bool, len(d.Reinforce))
	for _, id := range d.Reinforce {
		reinforceIDs[id] = true
	}

	// Resolve keep: drop if hallucinated or if also in reinforce/update/delete.
	keepOut := d.Keep[:0]
	for _, id := range d.Keep {
		if !valid[id] {
			rep.HallucinatedKeep++
			continue
		}
		if reinforceIDs[id] {
			rep.OverlapKeepReinforce++
			continue
		}
		if updateIDs[id] {
			rep.OverlapKeepUpdate++
			continue
		}
		if deleteIDs[id] {
			rep.OverlapKeepDelete++
			continue
		}
		keepOut = append(keepOut, id)
	}

	// Resolve reinforce: drop if hallucinated or if also in update/delete.
	reinforceOut := d.Reinforce[:0]
	for _, id := range d.Reinforce {
		if !valid[id] {
			rep.HallucinatedReinforce++
			continue
		}
		if updateIDs[id] {
			rep.OverlapReinforceUpdate++
			continue
		}
		if deleteIDs[id] {
			rep.OverlapReinforceDelete++
			continue
		}
		reinforceOut = append(reinforceOut, id)
	}

	// Resolve update: drop if hallucinated or if also in delete.
	updateOut := d.Update[:0]
	for _, op := range d.Update {
		if !valid[op.ID] {
			rep.HallucinatedUpdate++
			continue
		}
		if deleteIDs[op.ID] {
			rep.OverlapUpdateDelete++
			continue
		}
		updateOut = append(updateOut, op)
	}

	// Resolve delete: drop only if hallucinated.
	deleteOut := d.Delete[:0]
	for _, id := range d.Delete {
		if !valid[id] {
			rep.HallucinatedDelete++
			continue
		}
		deleteOut = append(deleteOut, id)
	}

	// Resolve inserts: drop if empty content.
	insertOut := d.Insert[:0]
	for _, op := range d.Insert {
		if strings.TrimSpace(op.Content) == "" {
			rep.EmptyInsert++
			continue
		}
		insertOut = append(insertOut, op)
	}

	out := MemoryDiff{
		Keep:      keepOut,
		Reinforce: reinforceOut,
		Update:    updateOut,
		Delete:    deleteOut,
		Insert:    insertOut,
	}
	return out, rep
}

// diffHasOps returns true if the diff contains any non-insert operations or any inserts.
func diffHasOps(d MemoryDiff) bool {
	return len(d.Keep) > 0 || len(d.Reinforce) > 0 || len(d.Update) > 0 ||
		len(d.Delete) > 0 || len(d.Insert) > 0
}

// ApplyMemoryDiff resolves the diff against existing items (re-queried inside
// the tx for race safety) and applies all operations atomically.
// Overlapping IDs and hallucinated IDs are auto-resolved instead of rejected.
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
	validIDs := make(map[uuid.UUID]bool)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		validIDs[id] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}

	// Auto-resolve overlaps and hallucinated IDs.
	resolved, report := resolveAndValidateDiff(diff, validIDs)
	if !report.IsEmpty() {
		slog.Warn("consolidation diff resolved",
			"kind", opts.Dimension,
			"namespace", opts.Namespace,
			slog.Int("overlap_keep_reinforce", report.OverlapKeepReinforce),
			slog.Int("overlap_keep_update", report.OverlapKeepUpdate),
			slog.Int("overlap_keep_delete", report.OverlapKeepDelete),
			slog.Int("overlap_reinforce_update", report.OverlapReinforceUpdate),
			slog.Int("overlap_reinforce_delete", report.OverlapReinforceDelete),
			slog.Int("overlap_update_delete", report.OverlapUpdateDelete),
			slog.Int("hallucinated_keep", report.HallucinatedKeep),
			slog.Int("hallucinated_reinforce", report.HallucinatedReinforce),
			slog.Int("hallucinated_update", report.HallucinatedUpdate),
			slog.Int("hallucinated_delete", report.HallucinatedDelete),
			slog.Int("empty_insert", report.EmptyInsert),
		)
	}

	if !diffHasOps(resolved) {
		// Nothing to do.
		return nil
	}

	now := time.Now().UTC()
	newExpiresAt := expiresAtFromTTL(now, opts.TTLDays)

	// keep: no SQL action.

	// reinforce: bump updated_at, expires_at, reinforced_count, source_event_ids.
	for _, id := range resolved.Reinforce {
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

	// update: set content+tags+embedding (if provided), bump updated_at, expires_at, source_event_ids.
	for _, op := range resolved.Update {
		tagsJSON := tagsToJSON(op.Tags)
		var q string
		var args []any
		if op.Embedding != nil {
			embVal := pgvector.NewVector(op.Embedding)
			if newExpiresAt != nil {
				q = `UPDATE memories
				     SET content          = $2,
				         tags             = $3,
				         updated_at       = $4,
				         expires_at       = $5,
				         embedding        = $6,
				         source_event_ids = array_append(source_event_ids, $7::uuid)
				   WHERE memory_id = $1`
				args = []any{op.ID, op.Content, tagsJSON, now, *newExpiresAt, embVal, opts.SourceEventID}
			} else {
				q = `UPDATE memories
				     SET content          = $2,
				         tags             = $3,
				         updated_at       = $4,
				         expires_at       = NULL,
				         embedding        = $5,
				         source_event_ids = array_append(source_event_ids, $6::uuid)
				   WHERE memory_id = $1`
				args = []any{op.ID, op.Content, tagsJSON, now, embVal, opts.SourceEventID}
			}
		} else {
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
		}
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return fmt.Errorf("ApplyMemoryDiff update %s: %w", op.ID, err)
		}
	}

	// delete: hard delete.
	for _, id := range resolved.Delete {
		if _, err := tx.ExecContext(ctx, `DELETE FROM memories WHERE memory_id = $1`, id); err != nil {
			return fmt.Errorf("ApplyMemoryDiff delete %s: %w", id, err)
		}
	}

	// insert: new rows.
	for _, op := range resolved.Insert {
		id := uuid.New()
		tagsJSON := tagsToJSON(op.Tags)
		var expiresVal interface{}
		if newExpiresAt != nil {
			expiresVal = *newExpiresAt
		}
		var embVal interface{}
		if op.Embedding != nil {
			embVal = pgvector.NewVector(op.Embedding)
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO memories (
				memory_id, actor_id, dimension, namespace, content,
				tags, attributes, source_event_ids, reinforced_count,
				created_at, updated_at, expires_at, embedding
			) VALUES ($1, $2, $3, $4, $5, $6, '{}', ARRAY[$7::uuid], 1, $8, $8, $9, $10)
		`, id, opts.ActorID, opts.Dimension, opts.Namespace, op.Content,
			tagsJSON, opts.SourceEventID, now, expiresVal, embVal)
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
	b, err := json.Marshal(tags)
	if err != nil {
		// Should never happen for []string, but fall back to empty array
		// rather than producing invalid JSON.
		return []byte("[]")
	}
	return b
}
