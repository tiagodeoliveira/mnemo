package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestInsertItemAndListByNamespace(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	ns := "/preferences/alice/"
	tx, _ := s.DB.BeginTx(ctx, nil)
	id1, err := s.InsertItem(ctx, tx, ItemInput{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		Content:       "uses Go for backend services",
		Tags:          []string{"language", "tool"},
		SourceEventID: eventID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.InsertItem(ctx, tx, ItemInput{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		Content:       "prefers tabs over spaces",
		Tags:          []string{"style"},
		SourceEventID: eventID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d", len(items))
	}
	// Items are returned oldest-first; both have the same created_at so order may vary.
	found := false
	for _, m := range items {
		if m.ID == id1 && m.Content == "uses Go for backend services" {
			found = true
			if len(m.Tags) != 2 {
				t.Errorf("want 2 tags, got %v", m.Tags)
			}
			if len(m.SourceEventIDs) != 1 || m.SourceEventIDs[0] != eventID {
				t.Errorf("want source_event_id=%s, got %v", eventID, m.SourceEventIDs)
			}
			if m.ReinforcedCount != 1 {
				t.Errorf("want reinforced_count=1, got %d", m.ReinforcedCount)
			}
		}
	}
	if !found {
		t.Error("inserted item not found in list result")
	}
}

func TestListItems(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, item := range []struct {
		ns  string
		dim string
		c   string
	}{
		{"/preferences/alice/", "preferences", "uses Go"},
		{"/preferences/alice/", "preferences", "likes Rust"},
		{"/about/alice/", "about", "senior engineer"},
	} {
		if _, err := s.InsertItem(ctx, tx, ItemInput{
			ActorID:       "alice",
			Dimension:     item.dim,
			Namespace:     item.ns,
			Content:       item.c,
			SourceEventID: eventID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	got, err := s.ListItems(ctx, ListItemsOpts{ActorID: "alice", Dimension: "preferences"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Errorf("want 2 preference items, got %d", len(got))
	}

	got2, err := s.ListItems(ctx, ListItemsOpts{ActorID: "alice", NamespacePrefix: "/about/"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) != 1 {
		t.Errorf("want 1 about item, got %d", len(got2))
	}
}

func TestApplyMemoryDiffInsert(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	ns := "/preferences/alice/"
	opts := DiffApplyOpts{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		SourceEventID: eventID,
		TTLDays:       365,
	}
	diff := MemoryDiff{
		Insert: []InsertOp{
			{Content: "uses Go", Tags: []string{"language"}},
			{Content: "prefers vim", Tags: []string{"tool"}},
		},
	}

	tx, _ := s.DB.BeginTx(ctx, nil)
	if err := s.ApplyMemoryDiff(ctx, tx, opts, diff); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 items after insert diff, got %d", len(items))
	}
	for _, m := range items {
		if !m.ExpiresAt.Valid {
			t.Error("expires_at should be set for TTLDays=365")
		}
	}
}

func TestApplyMemoryDiffReinforce(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID1 := uuid.New()
	eventID2 := uuid.New()
	ns := "/preferences/alice/"

	// Insert initial item.
	tx, _ := s.DB.BeginTx(ctx, nil)
	itemID, _ := s.InsertItem(ctx, tx, ItemInput{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		Content:       "uses Go",
		Tags:          []string{"language"},
		SourceEventID: eventID1,
		ExpiresAt:     sql.NullTime{},
	})
	_ = tx.Commit()

	// Apply reinforce diff.
	opts := DiffApplyOpts{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		SourceEventID: eventID2,
		TTLDays:       365,
	}
	diff := MemoryDiff{Reinforce: []uuid.UUID{itemID}}

	tx2, _ := s.DB.BeginTx(ctx, nil)
	if err := s.ApplyMemoryDiff(ctx, tx2, opts, diff); err != nil {
		t.Fatal(err)
	}
	_ = tx2.Commit()

	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	m := items[0]
	if m.ReinforcedCount != 2 {
		t.Errorf("want reinforced_count=2, got %d", m.ReinforcedCount)
	}
	if len(m.SourceEventIDs) != 2 {
		t.Errorf("want 2 source_event_ids, got %d", len(m.SourceEventIDs))
	}
	if !m.ExpiresAt.Valid {
		t.Error("expires_at should be set after reinforce with TTLDays=365")
	}
}

func TestApplyMemoryDiffDelete(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	ns := "/preferences/alice/"
	tx, _ := s.DB.BeginTx(ctx, nil)
	itemID, _ := s.InsertItem(ctx, tx, ItemInput{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		Content:       "old pref",
		SourceEventID: eventID,
	})
	_ = tx.Commit()

	opts := DiffApplyOpts{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		SourceEventID: uuid.New(),
	}
	diff := MemoryDiff{Delete: []uuid.UUID{itemID}}

	tx2, _ := s.DB.BeginTx(ctx, nil)
	if err := s.ApplyMemoryDiff(ctx, tx2, opts, diff); err != nil {
		t.Fatal(err)
	}
	_ = tx2.Commit()

	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Errorf("want 0 items after delete, got %d", len(items))
	}
}

func TestApplyMemoryDiffUpdate(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	ns := "/preferences/alice/"
	tx, _ := s.DB.BeginTx(ctx, nil)
	itemID, _ := s.InsertItem(ctx, tx, ItemInput{
		ActorID:       "alice",
		Dimension:     "preferences",
		Namespace:     ns,
		Content:       "old content",
		Tags:          []string{"tool"},
		SourceEventID: eventID,
	})
	_ = tx.Commit()

	opts := DiffApplyOpts{
		ActorID: "alice", Dimension: "preferences", Namespace: ns,
		SourceEventID: uuid.New(),
	}
	diff := MemoryDiff{
		Update: []UpdateOp{{ID: itemID, Content: "new content", Tags: []string{"language", "tool"}}},
	}

	tx2, _ := s.DB.BeginTx(ctx, nil)
	if err := s.ApplyMemoryDiff(ctx, tx2, opts, diff); err != nil {
		t.Fatal(err)
	}
	_ = tx2.Commit()

	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	m := items[0]
	if m.Content != "new content" {
		t.Errorf("want updated content, got %s", m.Content)
	}
	if len(m.Tags) != 2 {
		t.Errorf("want 2 tags, got %v", m.Tags)
	}
}

func TestApplyMemoryDiffHallucinatedIDSilentlyDropped(t *testing.T) {
	// Hallucinated IDs are now auto-resolved (dropped) rather than rejected.
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	ns := "/preferences/alice/"
	opts := DiffApplyOpts{
		ActorID: "alice", Dimension: "preferences", Namespace: ns,
		SourceEventID: uuid.New(),
	}
	diff := MemoryDiff{
		Reinforce: []uuid.UUID{uuid.New()}, // non-existent ID — should be dropped silently
	}

	tx, _ := s.DB.BeginTx(ctx, nil)
	err := s.ApplyMemoryDiff(ctx, tx, opts, diff)
	_ = tx.Commit()
	if err != nil {
		t.Fatalf("expected hallucinated reinforce ID to be silently dropped, got err: %v", err)
	}
}

// TestResolveDiff_KeepUpdateOverlap verifies that an ID in both keep and update
// is dropped from keep (update wins).
func TestResolveDiff_KeepUpdateOverlap(t *testing.T) {
	id := uuid.New()
	valid := map[uuid.UUID]bool{id: true}
	d := MemoryDiff{
		Keep:   []uuid.UUID{id},
		Update: []UpdateOp{{ID: id, Content: "new content"}},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if len(out.Keep) != 0 {
		t.Errorf("keep should be empty after overlap with update, got %v", out.Keep)
	}
	if len(out.Update) != 1 || out.Update[0].ID != id {
		t.Errorf("update should still contain id, got %v", out.Update)
	}
	if rep.OverlapKeepUpdate != 1 {
		t.Errorf("expected OverlapKeepUpdate=1, got %d", rep.OverlapKeepUpdate)
	}
}

// TestResolveDiff_KeepReinforceOverlap verifies that an ID in both keep and
// reinforce is dropped from keep (reinforce wins).
func TestResolveDiff_KeepReinforceOverlap(t *testing.T) {
	id := uuid.New()
	valid := map[uuid.UUID]bool{id: true}
	d := MemoryDiff{
		Keep:      []uuid.UUID{id},
		Reinforce: []uuid.UUID{id},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if len(out.Keep) != 0 {
		t.Errorf("keep should be empty, got %v", out.Keep)
	}
	if len(out.Reinforce) != 1 {
		t.Errorf("reinforce should still contain id, got %v", out.Reinforce)
	}
	if rep.OverlapKeepReinforce != 1 {
		t.Errorf("expected OverlapKeepReinforce=1, got %d", rep.OverlapKeepReinforce)
	}
}

// TestResolveDiff_ReinforceUpdateOverlap verifies that an ID in both reinforce
// and update is dropped from reinforce (update wins).
func TestResolveDiff_ReinforceUpdateOverlap(t *testing.T) {
	id := uuid.New()
	valid := map[uuid.UUID]bool{id: true}
	d := MemoryDiff{
		Reinforce: []uuid.UUID{id},
		Update:    []UpdateOp{{ID: id, Content: "updated"}},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if len(out.Reinforce) != 0 {
		t.Errorf("reinforce should be empty after overlap with update, got %v", out.Reinforce)
	}
	if len(out.Update) != 1 {
		t.Errorf("update should still contain id, got %v", out.Update)
	}
	if rep.OverlapReinforceUpdate != 1 {
		t.Errorf("expected OverlapReinforceUpdate=1, got %d", rep.OverlapReinforceUpdate)
	}
}

// TestResolveDiff_UpdateDeleteOverlap verifies that an ID in both update and
// delete is dropped from update (delete wins).
func TestResolveDiff_UpdateDeleteOverlap(t *testing.T) {
	id := uuid.New()
	valid := map[uuid.UUID]bool{id: true}
	d := MemoryDiff{
		Update: []UpdateOp{{ID: id, Content: "updated"}},
		Delete: []uuid.UUID{id},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if len(out.Update) != 0 {
		t.Errorf("update should be empty after overlap with delete, got %v", out.Update)
	}
	if len(out.Delete) != 1 {
		t.Errorf("delete should still contain id, got %v", out.Delete)
	}
	if rep.OverlapUpdateDelete != 1 {
		t.Errorf("expected OverlapUpdateDelete=1, got %d", rep.OverlapUpdateDelete)
	}
}

// TestResolveDiff_HallucinatedID verifies that IDs not in the existing set are
// silently dropped.
func TestResolveDiff_HallucinatedID(t *testing.T) {
	realID := uuid.New()
	fakeID := uuid.New()
	valid := map[uuid.UUID]bool{realID: true}
	d := MemoryDiff{
		Keep:      []uuid.UUID{fakeID},
		Reinforce: []uuid.UUID{fakeID},
		Update:    []UpdateOp{{ID: fakeID, Content: "x"}},
		Delete:    []uuid.UUID{fakeID},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if len(out.Keep) != 0 || len(out.Reinforce) != 0 || len(out.Update) != 0 || len(out.Delete) != 0 {
		t.Errorf("all hallucinated ops should be dropped, got keep=%v reinforce=%v update=%v delete=%v",
			out.Keep, out.Reinforce, out.Update, out.Delete)
	}
	if rep.HallucinatedKeep != 1 {
		t.Errorf("expected HallucinatedKeep=1, got %d", rep.HallucinatedKeep)
	}
	if rep.HallucinatedReinforce != 1 {
		t.Errorf("expected HallucinatedReinforce=1, got %d", rep.HallucinatedReinforce)
	}
	if rep.HallucinatedUpdate != 1 {
		t.Errorf("expected HallucinatedUpdate=1, got %d", rep.HallucinatedUpdate)
	}
	if rep.HallucinatedDelete != 1 {
		t.Errorf("expected HallucinatedDelete=1, got %d", rep.HallucinatedDelete)
	}
}

// TestResolveDiff_EmptyAfterResolution verifies that a diff consisting entirely
// of hallucinated IDs results in an empty report (IsEmpty == true after all drops).
func TestResolveDiff_EmptyAfterResolution(t *testing.T) {
	fakeID := uuid.New()
	valid := map[uuid.UUID]bool{} // no real IDs
	d := MemoryDiff{
		Keep:      []uuid.UUID{fakeID},
		Reinforce: []uuid.UUID{fakeID},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if diffHasOps(out) {
		t.Errorf("expected empty diff after resolution, got %+v", out)
	}
	if rep.IsEmpty() {
		t.Error("report should not be empty — resolutions were made")
	}
	if rep.Total() != 2 {
		t.Errorf("expected Total=2, got %d", rep.Total())
	}
}

// TestResolveDiff_NoChanges verifies that a valid diff with no overlaps and no
// hallucinations passes through unmodified with report.Total() == 0.
func TestResolveDiff_NoChanges(t *testing.T) {
	id1 := uuid.New()
	id2 := uuid.New()
	valid := map[uuid.UUID]bool{id1: true, id2: true}
	d := MemoryDiff{
		Keep:      []uuid.UUID{id1},
		Reinforce: []uuid.UUID{id2},
		Insert:    []InsertOp{{Content: "new item"}},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if rep.Total() != 0 {
		t.Errorf("expected no resolutions, got report=%+v", rep)
	}
	if len(out.Keep) != 1 || out.Keep[0] != id1 {
		t.Errorf("keep unchanged expected, got %v", out.Keep)
	}
	if len(out.Reinforce) != 1 || out.Reinforce[0] != id2 {
		t.Errorf("reinforce unchanged expected, got %v", out.Reinforce)
	}
	if len(out.Insert) != 1 {
		t.Errorf("insert unchanged expected, got %v", out.Insert)
	}
}

// TestResolveDiff_EmptyInsertDropped verifies that inserts with empty content
// are dropped.
func TestResolveDiff_EmptyInsertDropped(t *testing.T) {
	valid := map[uuid.UUID]bool{}
	d := MemoryDiff{
		Insert: []InsertOp{
			{Content: ""},
			{Content: "  "},
			{Content: "valid content"},
		},
	}
	out, rep := resolveAndValidateDiff(d, valid)
	if len(out.Insert) != 1 || out.Insert[0].Content != "valid content" {
		t.Errorf("expected 1 valid insert, got %v", out.Insert)
	}
	if rep.EmptyInsert != 2 {
		t.Errorf("expected EmptyInsert=2, got %d", rep.EmptyInsert)
	}
}

func TestDeleteAppendItemsForEvent(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	tx, _ := s.DB.BeginTx(ctx, nil)
	for i := 0; i < 3; i++ {
		if _, err := s.InsertItem(ctx, tx, ItemInput{
			ActorID:       "alice",
			Dimension:     "daily_log",
			Namespace:     "/daily/alice/2026-05-14/log/",
			Content:       "log entry",
			SourceEventID: eventID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	var n int
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='daily_log'`).Scan(&n)
	if n != 3 {
		t.Fatalf("expected 3 rows before delete, got %d", n)
	}

	tx2, _ := s.DB.BeginTx(ctx, nil)
	if err := s.DeleteAppendItemsForEvent(ctx, tx2, eventID, []string{"daily_log"}); err != nil {
		t.Fatal(err)
	}
	_ = tx2.Commit()

	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='daily_log'`).Scan(&n)
	if n != 0 {
		t.Errorf("expected 0 rows after delete, got %d", n)
	}
}

// TestReplaceItemByNamespace covers the single-row-per-namespace pattern used
// by digest (daily_summary) and meeting (per-category) writes: each call
// supersedes any prior row at the same (actor, namespace).
func TestReplaceItemByNamespace(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	ns := "/meetings/alice/m1/summary/"
	tx, _ := s.DB.BeginTx(ctx, nil)
	if err := s.ReplaceItemByNamespace(ctx, tx, ItemInput{
		ActorID: "alice", Dimension: "meeting", Namespace: ns, Content: "v1",
	}); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	tx2, _ := s.DB.BeginTx(ctx, nil)
	if err := s.ReplaceItemByNamespace(ctx, tx2, ItemInput{
		ActorID: "alice", Dimension: "meeting", Namespace: ns, Content: "v2",
	}); err != nil {
		t.Fatal(err)
	}
	_ = tx2.Commit()

	var content string
	var count int
	_ = s.DB.QueryRow(`SELECT count(*), max(content) FROM memories WHERE actor_id='alice' AND namespace=$1`, ns).Scan(&count, &content)
	if count != 1 {
		t.Errorf("want 1 row after upsert, got %d", count)
	}
	if content != "v2" {
		t.Errorf("want content=v2, got %s", content)
	}
}

// unused import guard
var _ = json.Marshal
