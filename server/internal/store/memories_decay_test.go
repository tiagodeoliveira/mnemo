package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DeleteExpiredMemories must remove only rows whose expires_at has passed,
// leaving never-expiring (NULL) and future-dated rows intact.
func TestDeleteExpiredMemories(t *testing.T) {
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
	ns := "/about/alice/"
	now := time.Now().UTC()
	tx, _ := s.DB.BeginTx(ctx, nil)
	// expired
	expiredID, err := s.InsertItem(ctx, tx, ItemInput{
		ActorID: "alice", Dimension: "about", Namespace: ns,
		Content: "one-off session note", SourceEventID: uuid.New(),
		ExpiresAt: sql.NullTime{Time: now.Add(-time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	// future
	if _, err := s.InsertItem(ctx, tx, ItemInput{
		ActorID: "alice", Dimension: "about", Namespace: ns,
		Content: "still valid", SourceEventID: uuid.New(),
		ExpiresAt: sql.NullTime{Time: now.Add(time.Hour), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	// never expires (NULL)
	if _, err := s.InsertItem(ctx, tx, ItemInput{
		ActorID: "alice", Dimension: "about", Namespace: ns,
		Content: "durable fact", SourceEventID: uuid.New(),
	}); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	n, err := s.DeleteExpiredMemories(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 expired row deleted, got %d", n)
	}
	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 surviving rows, got %d", len(items))
	}
	for _, m := range items {
		if m.ID == expiredID {
			t.Fatalf("expired row %s was not deleted", expiredID)
		}
	}
}

// A diff applied with PromoteAtReinforced must null out expires_at for every row
// in the namespace whose reinforced_count has reached the threshold — including
// rows it did not directly touch (namespace-wide promotion heals legacy rows).
func TestApplyMemoryDiffPromotesReinforcedToPermanent(t *testing.T) {
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
	ns := "/about/alice/"
	future := time.Now().UTC().Add(60 * 24 * time.Hour)

	tx, _ := s.DB.BeginTx(ctx, nil)
	// durable: already reinforced to the threshold, still carries a TTL.
	durableID, err := s.InsertItem(ctx, tx, ItemInput{
		ActorID: "alice", Dimension: "about", Namespace: ns,
		Content: "Alice is a staff engineer", SourceEventID: uuid.New(),
		ExpiresAt: sql.NullTime{Time: future, Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	// one-off: low reinforcement, should keep its TTL.
	oneOffID, err := s.InsertItem(ctx, tx, ItemInput{
		ActorID: "alice", Dimension: "about", Namespace: ns,
		Content: "Alice ran the tests today", SourceEventID: uuid.New(),
		ExpiresAt: sql.NullTime{Time: future, Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Push the durable row's reinforced_count to the promotion threshold.
	if _, err := tx.ExecContext(ctx,
		`UPDATE memories SET reinforced_count = 3 WHERE memory_id = $1`, durableID); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	// Apply a diff that reinforces the one-off (gives the diff an op so the
	// apply proceeds); promotion is namespace-wide.
	tx2, _ := s.DB.BeginTx(ctx, nil)
	err = s.ApplyMemoryDiff(ctx, tx2, DiffApplyOpts{
		ActorID: "alice", Dimension: "about", Namespace: ns,
		SourceEventID: uuid.New(), TTLDays: 60, PromoteAtReinforced: 3,
	}, MemoryDiff{Reinforce: []uuid.UUID{oneOffID}})
	if err != nil {
		t.Fatal(err)
	}
	_ = tx2.Commit()

	items, err := s.ListItemsByNamespace(ctx, "alice", ns)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range items {
		switch m.ID {
		case durableID:
			if m.ExpiresAt.Valid {
				t.Errorf("durable row (rc>=3) should be promoted to permanent, got expires_at=%v", m.ExpiresAt.Time)
			}
		case oneOffID:
			if !m.ExpiresAt.Valid {
				t.Errorf("one-off row (rc<3) should keep its TTL, got permanent")
			}
		}
	}
}
