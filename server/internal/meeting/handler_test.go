package meeting

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func TestParseMeetingSummaryHappy(t *testing.T) {
	in := `SUMMARY:
Speaker 1 and Speaker 2 met to discuss the rewrite.

DECISIONS:
Move to Go on a self-hosted VPS.

ACTIONS:
[Speaker 1] will draft the spec by Friday.

QUESTIONS:
NONE

HIGHLIGHTS:
[Speaker 2]: "We need to ship this in a week."

FOLLOWUPS:
NONE`
	got, err := ParseMeetingSummary(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got["summary"], "rewrite") {
		t.Errorf("summary: %q", got["summary"])
	}
	if !strings.Contains(got["decisions"], "Go on a self-hosted") {
		t.Errorf("decisions: %q", got["decisions"])
	}
	if got["questions"] != "" {
		t.Errorf("NONE not normalized: %q", got["questions"])
	}
	if !strings.Contains(got["highlights"], "ship this in a week") {
		t.Errorf("highlights: %q", got["highlights"])
	}
	if got["followups"] != "" {
		t.Errorf("NONE not normalized: %q", got["followups"])
	}
}

func TestParseMeetingSummaryNoLabelsErrors(t *testing.T) {
	if _, err := ParseMeetingSummary("just prose, no labels"); err == nil {
		t.Fatal("expected error when no labels")
	}
}

func TestMeetingHandlerWritesCategories(t *testing.T) {
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

	// Two events for the same meeting, ordered.
	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, content := range []string{"Speaker 1 hi", "Speaker 2 there"} {
		_, err := s.InsertEvent(ctx, tx, store.EventInput{
			ActorID: "alice", SessionID: "s",
			Turns:      json.RawMessage(`[{"role":"user","content":"` + content + `"}]`),
			Attributes: json.RawMessage(`{"meeting_id":"m1"}`),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		return llm.CompleteResponse{Text: `SUMMARY:
Two speakers chatted.

DECISIONS:
NONE

ACTIONS:
NONE

QUESTIONS:
NONE

HIGHLIGHTS:
[Speaker 1]: "hi"

FOLLOWUPS:
NONE`}, nil
	}}
	h := &Handler{Store: s, LLM: stub, Model: "claude-test"}
	if err := h.Handle(ctx, []byte(`{"actor_id":"alice","meeting_id":"m1"}`)); err != nil {
		t.Fatal(err)
	}

	// Should produce 2 rows: summary and highlights (NONE categories skipped).
	var n int
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='meeting'`,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("want 2 meeting rows got %d", n)
	}
}

func TestMeetingHandlerEmptyMeetingErrors(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}

	h := &Handler{Store: s, LLM: &llm.Stub{}, Model: "x"}
	if err := h.Handle(context.Background(),
		[]byte(`{"actor_id":"alice","meeting_id":"nonexistent"}`)); err == nil {
		t.Fatal("expected error on empty meeting")
	}
}
