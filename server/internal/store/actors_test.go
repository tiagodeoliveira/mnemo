package store

import (
	"context"
	"testing"
)

func TestUpsertActor(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
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
}
