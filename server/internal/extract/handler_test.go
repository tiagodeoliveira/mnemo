package extract

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func setup(t *testing.T) (*store.Store, *Handler, uuid.UUID) {
	t.Helper()
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := s.InsertEvent(ctx, tx, store.EventInput{
		ActorID:   "alice",
		SessionID: "s1",
		Project:   "demo",
		Turns:     json.RawMessage(`[{"role":"user","content":"I prefer Go for backends"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		// Distinguish calls by content of the user message or the system prompt.
		userMsg := ""
		if len(req.Messages) > 0 {
			userMsg = req.Messages[0].Content
		}
		switch {
		case strings.Contains(userMsg, "CLASSIFY THE TASK DOMAIN"):
			// Classifier prompt (project/task/daily log)
			return llm.CompleteResponse{Text: "TASK: coding\nFACTS:\nUses Go for backend services.\nDAILY:\nDiscussed Go preferences."}, nil
		case strings.Contains(userMsg, "biographical"):
			// About extractor prompt
			return llm.CompleteResponse{Text: "tiago is a senior engineer."}, nil
		case strings.Contains(userMsg, "ABOUT memory"):
			// Consolidation for about dimension
			return llm.CompleteResponse{Text: "the actor is a senior engineer who prefers Go."}, nil
		case strings.Contains(userMsg, "PROJECT memory"):
			return llm.CompleteResponse{Text: "consolidated project record"}, nil
		case strings.Contains(userMsg, "TASK memory"):
			return llm.CompleteResponse{Text: "consolidated task record"}, nil
		}
		// Fallback for system-prompt-keyed calls (preferences, facts/episodes)
		switch req.System {
		case SystemPreferences:
			return llm.CompleteResponse{Text: `{"preferences":["use Go for backend services"]}`}, nil
		case SystemEpisodes:
			return llm.CompleteResponse{Text: `{"episodes":[]}`}, nil
		}
		return llm.CompleteResponse{Text: ""}, nil
	}}

	h := &Handler{Store: s, LLM: stub, Model: "claude-test"}
	return s, h, rec.EventID
}

func TestExtractHandlerFirstWriteAllDimensions(t *testing.T) {
	s, h, evID := setup(t)
	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: evID})
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}

	counts := map[string]int{}
	rows, err := s.DB.Query(`SELECT dimension, count(*) FROM memories WHERE actor_id='alice' GROUP BY dimension`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			t.Fatal(err)
		}
		counts[d] = n
	}

	// First-write expectations:
	// - project (1 row, namespace /projects/alice/demo/) — first write, no consolidation, content == ptl.Facts
	// - task (1 row, namespace /tasks/alice/coding/) — same Facts string
	// - about (1 row, always consolidated)
	// - daily_log (1 row)
	// - preferences (1 row)
	// - episodes (0 rows — empty array from stub)
	// - facts dimension was dropped
	for dim, want := range map[string]int{
		"project": 1, "task": 1, "about": 1, "daily_log": 1, "preferences": 1,
	} {
		if counts[dim] != want {
			t.Errorf("dim %s: want %d got %d", dim, want, counts[dim])
		}
	}
	if counts["episodes"] != 0 {
		t.Errorf("episodes: want 0 got %d", counts["episodes"])
	}
	if counts["facts"] != 0 {
		t.Errorf("facts dimension should be gone: got %d rows", counts["facts"])
	}
}

func TestExtractHandlerIdempotentOnRetry(t *testing.T) {
	s, h, evID := setup(t)
	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: evID})
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	// Run again — append-dim rows for this event should be deleted+re-inserted,
	// not duplicated.
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	for _, dim := range []string{"preferences", "daily_log"} {
		var n int
		if err := s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension=$1`, dim).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("dim %s after retry: want 1 got %d", dim, n)
		}
	}
}
