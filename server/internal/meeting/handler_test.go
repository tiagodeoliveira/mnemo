package meeting

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func TestParseMeetingSummaryReturnsWholeBody(t *testing.T) {
	// The summary is now one free-form narrative memory: the parser returns
	// the whole LLM output verbatim (trimmed), with no category splitting.
	in := "\n  Speaker 1 and Speaker 2 met to discuss the rewrite.\n\n" +
		"They agreed to move to Go on a self-hosted VPS.\n\n" +
		"Open: whether to ship in a week.  \n"
	got, err := ParseMeetingSummary(in)
	if err != nil {
		t.Fatal(err)
	}
	want := "Speaker 1 and Speaker 2 met to discuss the rewrite.\n\n" +
		"They agreed to move to Go on a self-hosted VPS.\n\n" +
		"Open: whether to ship in a week."
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestParseMeetingSummaryEmptyErrors(t *testing.T) {
	if _, err := ParseMeetingSummary("   \n\t  "); err == nil {
		t.Fatal("expected error when the model returns an empty summary")
	}
}

func TestMeetingHandlerWritesSingleSummary(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	// A legacy category row for the same meeting must be swept on re-finalize
	// so the meeting ends up with exactly one durable memory.
	if _, err := s.DB.ExecContext(ctx,
		`INSERT INTO memories (memory_id, actor_id, dimension, namespace, content)
		 VALUES (gen_random_uuid(), 'alice', 'meeting', '/meetings/alice/m1/highlights/', 'old quote')`,
	); err != nil {
		t.Fatal(err)
	}

	// Two events for the same meeting, ordered.
	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, content := range []string{"[Speaker 1] hi", "[Speaker 2] there"} {
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

	const narrative = "Speaker 1 and Speaker 2 exchanged greetings and nothing else of substance."
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		return llm.CompleteResponse{Text: narrative}, nil
	}}
	h := &Handler{Store: s, LLM: stub, Model: "gpt-test"}
	if err := h.Handle(ctx, []byte(`{"actor_id":"alice","meeting_id":"m1"}`)); err != nil {
		t.Fatal(err)
	}

	// Exactly one meeting row: the summary. The legacy highlights row is gone.
	var n int
	var ns, content string
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='meeting'`,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want exactly 1 meeting row got %d", n)
	}
	if err := s.DB.QueryRow(
		`SELECT namespace, content FROM memories WHERE actor_id='alice' AND dimension='meeting'`,
	).Scan(&ns, &content); err != nil {
		t.Fatal(err)
	}
	if ns != "/meetings/alice/m1/summary/" {
		t.Errorf("summary namespace: %q", ns)
	}
	if content != narrative {
		t.Errorf("content: %q", content)
	}
}

func TestMeetingHandlerProjectsRoleAsSpeakerLabel(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	// Three turns exercising every branch of speakerLabel:
	//   - role="Tiago"     → named participant, prepended as "Tiago: ..."
	//   - role="Speaker 2" → anonymous id used verbatim as label
	//   - role="user"      → legacy generic role, content emitted as-is
	turns := []struct {
		role, content string
	}{
		{"Tiago", "let's ship it"},
		{"Speaker 2", "ship what exactly"},
		{"user", "[Speaker 3] I'm just observing"},
	}
	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, tr := range turns {
		body, _ := json.Marshal([]map[string]string{{"role": tr.role, "content": tr.content}})
		if _, err := s.InsertEvent(ctx, tx, store.EventInput{
			ActorID: "alice", SessionID: "s",
			Turns:      body,
			Attributes: json.RawMessage(`{"meeting_id":"m1"}`),
		}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	var seenPrompt string
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		seenPrompt = req.Messages[0].Content
		return llm.CompleteResponse{Text: "narrative"}, nil
	}}
	h := &Handler{Store: s, LLM: stub, Model: "gpt-test"}
	if err := h.Handle(ctx, []byte(`{"actor_id":"alice","meeting_id":"m1"}`)); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(seenPrompt, "Tiago: let's ship it") {
		t.Errorf("named role not projected as label; prompt=\n%s", seenPrompt)
	}
	if !strings.Contains(seenPrompt, "Speaker 2: ship what exactly") {
		t.Errorf("explicit anonymous id not projected as label; prompt=\n%s", seenPrompt)
	}
	if !strings.Contains(seenPrompt, "[Speaker 3] I'm just observing") {
		t.Errorf("legacy user-role content not emitted verbatim; prompt=\n%s", seenPrompt)
	}
	// The generic "user" role must NOT leak into the transcript as a label.
	if strings.Contains(seenPrompt, "user: [Speaker 3]") {
		t.Errorf("generic role leaked as label; prompt=\n%s", seenPrompt)
	}
}

func TestMeetingHandlerEmptyMeetingErrors(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
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
