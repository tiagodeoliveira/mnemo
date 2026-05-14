package queue

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
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

func TestBackfillEmbeddingsHandler(t *testing.T) {
	dsn := startPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	// Insert 2 rows directly with NULL embedding using raw SQL.
	eventID := uuid.New()
	for _, content := range []string{"alpha content", "beta content"} {
		_, err := s.DB.ExecContext(ctx, `
			INSERT INTO memories (
				memory_id, actor_id, dimension, namespace, content,
				tags, attributes, source_event_ids, reinforced_count
			) VALUES ($1, 'alice', 'preferences', '/preferences/alice/', $2,
			          '[]', '{}', ARRAY[$3::uuid], 1)
		`, uuid.New(), content, eventID)
		if err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	// Verify both rows have NULL embedding.
	var nullCount int
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE embedding IS NULL AND actor_id='alice'`).Scan(&nullCount)
	if nullCount != 2 {
		t.Fatalf("expected 2 NULL embeddings before backfill, got %d", nullCount)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &BackfillEmbeddingsHandler{
		Store:  s,
		Embed:  &embed.Stub{},
		Logger: logger,
	}

	if err := h.Handle(ctx, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("backfill handler: %v", err)
	}

	// Verify both rows now have non-NULL embedding.
	var remaining int
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE embedding IS NULL AND actor_id='alice'`).Scan(&remaining)
	if remaining != 0 {
		t.Errorf("expected 0 NULL embeddings after backfill, got %d", remaining)
	}
}
