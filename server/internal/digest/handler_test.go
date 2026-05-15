package digest

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func TestDigestHandlerWritesSummary(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	// Seed two daily_log entries for 2026-05-13.
	tx, _ := s.DB.BeginTx(ctx, nil)
	eventID := uuid.New()
	for _, entry := range []string{"worked on rewrite", "shipped task 24"} {
		if _, err := s.InsertItem(ctx, tx, store.ItemInput{
			ActorID: "alice", Dimension: "daily_log",
			Namespace: "/daily/alice/2026-05-13/log/", Content: entry,
			SourceEventID: eventID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		c := req.Messages[0].Content
		if !strings.Contains(c, "2026-05-13") {
			t.Errorf("missing date injection")
		}
		if !strings.Contains(c, "worked on rewrite") || !strings.Contains(c, "shipped task 24") {
			t.Errorf("missing log entries")
		}
		return llm.CompleteResponse{Text: "## Projects\nMnemo rewrite progressed.\n\n## Reflection\nGood day."}, nil
	}}
	h := &Handler{Store: s, LLM: stub, Model: "x", Mailer: &Mailer{}}
	if err := h.Handle(ctx, []byte(`{"actor_id":"alice","date":"2026-05-13"}`)); err != nil {
		t.Fatal(err)
	}

	var content string
	if err := s.DB.QueryRow(
		`SELECT content FROM memories WHERE actor_id='alice' AND dimension='daily_summary' AND namespace='/daily/alice/2026-05-13/summary/'`,
	).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "## Projects") || !strings.Contains(content, "## Reflection") {
		t.Fatalf("digest content missing sections: %s", content)
	}
}

func TestDigestHandlerNoLogsNoError(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}

	h := &Handler{Store: s, LLM: &llm.Stub{}, Model: "x", Mailer: &Mailer{}}
	// No logs seeded — should succeed silently without writing anything.
	if err := h.Handle(context.Background(), []byte(`{"actor_id":"alice","date":"2026-05-13"}`)); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM memories WHERE dimension='daily_summary'`,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("want no summary rows got %d", n)
	}
}

// uuid import kept-alive to avoid lint complaints if used elsewhere.
var _ = uuid.New
