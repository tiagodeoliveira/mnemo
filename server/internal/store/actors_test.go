package store

import (
	"context"
	"testing"
)

func TestUpsertActor(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	a1, err := s.UpsertActor(ctx, "auth0|alice")
	if err != nil || a1.ID != "auth0|alice" || a1.DisplayName != "auth0|alice" {
		t.Fatalf("a1: %+v err=%v", a1, err)
	}
	// Idempotent: second call returns same row, doesn't error.
	a2, err := s.UpsertActor(ctx, "auth0|alice")
	if err != nil || a2.CreatedAt != a1.CreatedAt {
		t.Fatalf("a2: %+v err=%v", a2, err)
	}
	// TTLOverrides defaults to empty map.
	if a1.TTLOverrides == nil {
		t.Error("TTLOverrides should not be nil")
	}
	if len(a1.TTLOverrides) != 0 {
		t.Errorf("TTLOverrides should default to empty, got %v", a1.TTLOverrides)
	}
}

func TestActorTTLOverrides(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "bob"); err != nil {
		t.Fatal(err)
	}

	// Set a TTL override for preferences.
	if _, err := s.DB.ExecContext(ctx,
		`UPDATE actors SET ttl_overrides = '{"preferences": 730}'::jsonb WHERE actor_id='bob'`); err != nil {
		t.Fatal(err)
	}

	a, err := s.GetActor(ctx, "bob")
	if err != nil || a == nil {
		t.Fatalf("GetActor: %v", err)
	}
	if v, ok := a.TTLOverrides["preferences"]; !ok || v != 730 {
		t.Errorf("want preferences TTL=730, got %v", a.TTLOverrides)
	}
}
