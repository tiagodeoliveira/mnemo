package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestUpsertConsolidatedAndQueryByPrefix(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil { t.Fatal(err) }
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil { t.Fatal(err) }

	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, ns := range []string{"/projects/alice/foo/", "/projects/alice/bar/"} {
		if err := s.UpsertConsolidatedMemory(ctx, tx, MemoryInput{
			ActorID: "alice", Dimension: "project", Namespace: ns, Content: "v1",
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Upsert again to confirm it updates rather than duplicates.
	if err := s.UpsertConsolidatedMemory(ctx, tx, MemoryInput{
		ActorID: "alice", Dimension: "project", Namespace: "/projects/alice/foo/", Content: "v2",
	}); err != nil { t.Fatal(err) }
	_ = tx.Commit()

	got, err := s.QueryByPrefix(ctx, RecallFilter{ActorID: "alice", NamespacePref: "/projects/alice/"})
	if err != nil { t.Fatal(err) }
	if len(got) != 2 { t.Fatalf("want 2 rows got %d", len(got)) }
	for _, m := range got {
		if m.Namespace == "/projects/alice/foo/" && m.Content != "v2" {
			t.Errorf("upsert did not update foo: %s", m.Content)
		}
	}

	// Attribute filter test.
	tx, _ = s.DB.BeginTx(ctx, nil)
	if err := s.InsertAppendMemory(ctx, tx, MemoryInput{
		ActorID: "alice", Dimension: "facts", Namespace: "/facts/alice/",
		Content: "fact1", Attributes: json.RawMessage(`{"owner":"tiago"}`),
	}); err != nil { t.Fatal(err) }
	_ = tx.Commit()
	got, err = s.QueryByPrefix(ctx, RecallFilter{
		ActorID: "alice", NamespacePref: "/facts/alice/",
		AttrFilters: map[string]string{"owner": "tiago"},
	})
	if err != nil { t.Fatal(err) }
	if len(got) != 1 { t.Fatalf("attr filter: want 1 got %d", len(got)) }
}
