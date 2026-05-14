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
	defer s.Close()
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
	defer s.Close()
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
	defer s.Close()
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
	defer s.Close()
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
	defer s.Close()
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
	defer s.Close()
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

func TestApplyMemoryDiffUnknownIDRejected(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
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
		Reinforce: []uuid.UUID{uuid.New()}, // non-existent ID
	}

	tx, _ := s.DB.BeginTx(ctx, nil)
	err := s.ApplyMemoryDiff(ctx, tx, opts, diff)
	_ = tx.Rollback()
	if err == nil {
		t.Fatal("expected error when diff references non-existent ID")
	}
}

func TestQueryByPrefix(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	eventID := uuid.New()
	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, ns := range []string{"/projects/alice/foo/", "/projects/alice/bar/"} {
		if _, err := s.InsertItem(ctx, tx, ItemInput{
			ActorID:       "alice",
			Dimension:     "project",
			Namespace:     ns,
			Content:       "fact for " + ns,
			SourceEventID: eventID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	got, err := s.QueryByPrefix(ctx, RecallFilter{ActorID: "alice", NamespacePref: "/projects/alice/"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 rows, got %d", len(got))
	}
}

func TestDeleteAppendItemsForEvent(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
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

// TestUpsertConsolidatedMemory exercises the backward-compat wrapper (used by
// meeting and digest handlers). It should delete+reinsert on repeat calls.
func TestUpsertConsolidatedMemory(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	ns := "/meetings/alice/m1/summary/"
	tx, _ := s.DB.BeginTx(ctx, nil)
	if err := s.UpsertConsolidatedMemory(ctx, tx, MemoryInput{
		ActorID: "alice", Dimension: "meeting", Namespace: ns, Content: "v1",
	}); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	tx2, _ := s.DB.BeginTx(ctx, nil)
	if err := s.UpsertConsolidatedMemory(ctx, tx2, MemoryInput{
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
