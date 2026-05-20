package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/api"
	"github.com/tiagodeoliveira/mnemo/server/internal/digest"
	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/extract"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/meeting"
	"github.com/tiagodeoliveira/mnemo/server/internal/queue"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func stubLLM() llm.Client {
	return &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		user := ""
		if len(req.Messages) > 0 {
			user = req.Messages[0].Content
		}
		// Extractor calls (by user message content):
		switch {
		case strings.Contains(user, "CLASSIFY THE TASK DOMAIN"):
			return llm.CompleteResponse{Text: "TASK: coding\nFACTS:\nUses Go.\nDAILY:\nWorked on demo."}, nil
		case strings.Contains(user, "extracting biographical"):
			return llm.CompleteResponse{Text: "ABOUT:\ntiago is a senior engineer."}, nil
		case strings.Contains(user, "Meeting id:"):
			return llm.CompleteResponse{Text: `SUMMARY:
Two speakers discussed mnemo.

DECISIONS:
NONE

ACTIONS:
NONE

QUESTIONS:
NONE

HIGHLIGHTS:
[Speaker 1]: "ship it"

FOLLOWUPS:
NONE`}, nil
		}
		// Consolidation calls (by system prompt):
		switch {
		case strings.Contains(req.System, "PREFERENCES memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"uses Go","tags":["language"]}]}`}, nil
		case strings.Contains(req.System, "ABOUT memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"tiago is a senior engineer","tags":["role"]}]}`}, nil
		case strings.Contains(req.System, "PROJECT memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"Uses Go","tags":["architecture"]}]}`}, nil
		case strings.Contains(req.System, "TASK memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"Uses Go","tags":["pattern"]}]}`}, nil
		}
		// Extractor system-prompt-keyed calls:
		switch req.System {
		case extract.SystemExtractPreferences:
			return llm.CompleteResponse{Text: `{"preferences":["uses Go"]}`}, nil
		case extract.SystemExtractEpisodes:
			return llm.CompleteResponse{Text: `{"episodes":[]}`}, nil
		}
		return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[]}`}, nil
	}}
}

// TestEventToRecallEndToEnd posts an event with meeting_ended=true and verifies
// that the worker processed both extract_context and finalize_meeting jobs,
// then recall returns the meeting summary.
func TestEventToRecallEndToEnd(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cli := stubLLM()
	stubEmbedClient := &embed.Stub{}
	extractH := &extract.Handler{Store: s, LLM: cli, Model: "x", Embed: stubEmbedClient}
	meetingH := &meeting.Handler{Store: s, LLM: cli, Model: "x", Embed: stubEmbedClient}
	digestH := &digest.Handler{Store: s, LLM: cli, Model: "x", Mailer: &digest.Mailer{}, Embed: stubEmbedClient}
	backfillH := &queue.BackfillEmbeddingsHandler{Store: s, Embed: stubEmbedClient, Logger: logger}
	handlers := map[store.JobKind]queue.Handler{
		store.KindExtractContext:     extractH.Handle,
		store.KindFinalizeMeeting:    meetingH.Handle,
		store.KindDailyDigest:        digestH.Handle,
		store.KindBackfillEmbeddings: backfillH.Handle,
	}
	pool := queue.NewPool(s, logger, 2, handlers)
	poolDone := make(chan struct{})
	go func() {
		pool.Run(ctx)
		close(poolDone)
	}()

	router := api.NewRouter(api.Deps{
		Store: s, Logger: logger,
		DevActorID:    "alice",
		EmbedClient:   stubEmbedClient,
		EmbedDisabled: false,
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{
		"session_id": "s1",
		"project":    "demo",
		"turns": []map[string]string{{"role": "user", "content": "Speaker 1 hi"}},
		"attributes": map[string]any{
			"meeting_id":    "m1",
			"meeting_ended": true,
		},
	})
	resp, err := http.Post(srv.URL+"/events", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusAccepted {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: %d body=%s", resp.StatusCode, string(raw))
	}

	// Wait for all jobs to drain.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var pending int
		if err := s.DB.QueryRow(
			`SELECT count(*) FROM jobs WHERE state IN ('pending','running')`,
		).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		if pending == 0 {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}

	// Verify meeting categories exist via recall.
	r, err := http.Get(srv.URL + "/recall?meeting=m1&visible=false")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Body.Close() }()
	raw, _ := io.ReadAll(r.Body)
	if !strings.Contains(string(raw), `"dimension":"meeting"`) {
		t.Fatalf("meeting not recalled: %s", string(raw))
	}
	if !strings.Contains(string(raw), "Two speakers discussed mnemo") {
		t.Fatalf("expected summary text missing: %s", string(raw))
	}

	// Verify the failed-job table is empty (no jobs ended in failed state).
	var failed int
	_ = s.DB.QueryRow(`SELECT count(*) FROM jobs WHERE state='failed'`).Scan(&failed)
	if failed != 0 {
		t.Errorf("expected 0 failed jobs, got %d", failed)
	}

	cancel()
	<-poolDone
}
