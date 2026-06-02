package queue

import (
	"context"
	"testing"
	"time"
)

func TestReaper_ReleasesStaleLocks(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()
	ctx := context.Background()

	// Insert a row in 'running' state with locked_at far in the past.
	if _, err := s.DB.Exec(`
		INSERT INTO jobs (kind, payload, state, locked_by, locked_at, attempts)
		VALUES ('extract_context', '{}'::jsonb, 'running', 'dead-worker', now() - interval '5 minutes', 1)
	`); err != nil {
		t.Fatal(err)
	}

	// And one with a fresh lock that should NOT be released.
	if _, err := s.DB.Exec(`
		INSERT INTO jobs (kind, payload, state, locked_by, locked_at, attempts)
		VALUES ('extract_context', '{}'::jsonb, 'running', 'alive-worker', now(), 1)
	`); err != nil {
		t.Fatal(err)
	}

	n, err := s.ReleaseStaleLocks(ctx, 90*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 lock released, got %d", n)
	}

	var pending, running int
	_ = s.DB.QueryRow(`SELECT count(*) FROM jobs WHERE state='pending'`).Scan(&pending)
	_ = s.DB.QueryRow(`SELECT count(*) FROM jobs WHERE state='running'`).Scan(&running)
	if pending != 1 || running != 1 {
		t.Fatalf("unexpected state: pending=%d running=%d", pending, running)
	}
}
