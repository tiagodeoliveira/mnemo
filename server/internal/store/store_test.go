package store

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func startPG(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	pg, err := postgres.Run(ctx, "pgvector/pgvector:pg16",
		postgres.WithDatabase("mnemo"),
		postgres.WithUsername("mnemo"),
		postgres.WithPassword("mnemo"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(time.Minute),
		),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = pg.Terminate(ctx) })

	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}
	return dsn
}

func TestMigrateUp(t *testing.T) {
	dsn := startPG(t)
	s, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = s.Close() }()

	if err := s.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var n int
	if err := s.DB.QueryRow(`
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name IN ('actors','events','memories','jobs')
	`).Scan(&n); err != nil {
		t.Fatalf("count tables: %v", err)
	}
	if n != 4 {
		t.Fatalf("expected 4 tables, got %d", n)
	}

	// Verify pgvector extension is present after migration.
	var extVersion string
	if err := s.DB.QueryRow(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`).Scan(&extVersion); err != nil {
		t.Fatalf("pgvector extension not found: %v", err)
	}
	t.Logf("pgvector extension version: %s", extVersion)

	// Idempotent.
	if err := s.Migrate(); err != nil {
		t.Fatalf("migrate idempotent: %v", err)
	}
}
