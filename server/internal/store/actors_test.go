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

func TestUpdateActorProfile(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "auth0|carol"); err != nil {
		t.Fatal(err)
	}

	// Verify defaults.
	a, err := s.GetActor(ctx, "auth0|carol")
	if err != nil || a == nil {
		t.Fatalf("GetActor: %v", err)
	}
	if a.DigestEnabled || a.Email.Valid || a.Timezone != "UTC" {
		t.Fatalf("unexpected defaults: %+v", a)
	}

	// Update all three fields at once.
	email := "carol@example.com"
	tz := "America/New_York"
	enabled := true
	updated, err := s.UpdateActorProfile(ctx, "auth0|carol", ActorProfileUpdate{
		Email:         &email,
		Timezone:      &tz,
		DigestEnabled: &enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Email.Valid || updated.Email.String != "carol@example.com" {
		t.Errorf("email: got %v", updated.Email)
	}
	if updated.Timezone != "America/New_York" {
		t.Errorf("timezone: got %s", updated.Timezone)
	}
	if !updated.DigestEnabled {
		t.Error("digest_enabled should be true")
	}

	// Partial update: only disable digest, leave email and tz intact.
	disabled := false
	partial, err := s.UpdateActorProfile(ctx, "auth0|carol", ActorProfileUpdate{
		DigestEnabled: &disabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if partial.DigestEnabled {
		t.Error("digest should be disabled")
	}
	if partial.Email.String != "carol@example.com" {
		t.Errorf("email should be unchanged, got %v", partial.Email)
	}
	if partial.Timezone != "America/New_York" {
		t.Errorf("tz should be unchanged, got %s", partial.Timezone)
	}

	// Empty update returns current state without error.
	noop, err := s.UpdateActorProfile(ctx, "auth0|carol", ActorProfileUpdate{})
	if err != nil {
		t.Fatal(err)
	}
	if noop.Timezone != "America/New_York" {
		t.Errorf("noop should return current state, got tz=%s", noop.Timezone)
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

func TestActorTaskDomainsSeededDefault(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	a, err := s.UpsertActor(context.Background(), "carol")
	if err != nil || a == nil {
		t.Fatalf("UpsertActor: %v", err)
	}
	want := []string{"coding", "studying", "meeting", "general"}
	if len(a.TaskDomains) != len(want) {
		t.Fatalf("TaskDomains seeded wrong: got %v, want %v", a.TaskDomains, want)
	}
	for i, d := range want {
		if a.TaskDomains[i] != d {
			t.Fatalf("TaskDomains[%d] = %q, want %q", i, a.TaskDomains[i], d)
		}
	}
}

func TestActorUpdateTaskDomainsRoundtrip(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "dave"); err != nil {
		t.Fatal(err)
	}

	domains := []string{"coding", "writing", "general"}
	updated, err := s.UpdateActorProfile(ctx, "dave", ActorProfileUpdate{TaskDomains: &domains})
	if err != nil || updated == nil {
		t.Fatalf("UpdateActorProfile: %v", err)
	}
	if len(updated.TaskDomains) != 3 || updated.TaskDomains[1] != "writing" {
		t.Fatalf("TaskDomains roundtrip: got %v", updated.TaskDomains)
	}

	// Confirm via GetActor.
	got, _ := s.GetActor(ctx, "dave")
	if got.TaskDomains[1] != "writing" {
		t.Fatalf("GetActor after update: got %v", got.TaskDomains)
	}
}
