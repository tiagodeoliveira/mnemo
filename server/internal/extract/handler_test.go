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

// stubConsolidationLLM returns a stub that handles all extractor AND
// consolidation calls. Extractor calls are identified by their prompt content;
// consolidation calls are routed by system prompt.
func stubConsolidationLLM() *llm.Stub {
	return &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		user := ""
		if len(req.Messages) > 0 {
			user = req.Messages[0].Content
		}
		// Extractor calls (via user message, no system prompt differentiator):
		switch {
		case strings.Contains(user, "CLASSIFY THE TASK DOMAIN"):
			return llm.CompleteResponse{Text: "TASK: coding\nPROJECT_FACTS:\nUses Go for backend services.\nTASK_FACTS:\nUses Go for backend services.\nDAILY:\nDiscussed Go preferences."}, nil
		case strings.Contains(user, "extracting biographical"):
			return llm.CompleteResponse{Text: "ABOUT:\ntiago is a senior engineer."}, nil
		}
		// Consolidation calls (via system prompt):
		switch {
		case strings.Contains(req.System, "PREFERENCES memory"):
			// Return a valid insert-only diff (first write).
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"uses Go for backend services","tags":["language"]}]}`}, nil
		case strings.Contains(req.System, "ABOUT memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"tiago is a senior engineer","tags":["role"]}]}`}, nil
		case strings.Contains(req.System, "PROJECT memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"Uses Go for backend services","tags":["architecture"]}]}`}, nil
		case strings.Contains(req.System, "TASK memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"Uses Go for backend services","tags":["pattern"]}]}`}, nil
		}
		// Extractor system-prompt-keyed calls:
		switch req.System {
		case SystemExtractPreferences:
			return llm.CompleteResponse{Text: `{"preferences":["uses Go for backend services"]}`}, nil
		case SystemExtractEpisodes:
			return llm.CompleteResponse{Text: `{"episodes":[]}`}, nil
		}
		return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[]}`}, nil
	}}
}

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

	h := &Handler{Store: s, LLM: stubConsolidationLLM(), Model: "claude-test"}
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
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			t.Fatal(err)
		}
		counts[d] = n
	}

	// First-write expectations with item model:
	// - project: 1+ items
	// - task: 1+ items
	// - about: 1+ items
	// - daily_log: 1 item
	// - preferences: 1+ items
	// - episodes: 0 items (empty array from stub)
	for dim, want := range map[string]int{
		"project": 1, "task": 1, "about": 1, "daily_log": 1, "preferences": 1,
	} {
		if counts[dim] < want {
			t.Errorf("dim %s: want at least %d got %d", dim, want, counts[dim])
		}
	}
	if counts["episodes"] != 0 {
		t.Errorf("episodes: want 0 got %d", counts["episodes"])
	}
}

func TestUserTurnsToTextFiltersNonUserRoles(t *testing.T) {
	raw := json.RawMessage(`[
		{"role":"user","content":"I'm Tiago, a Go engineer."},
		{"role":"assistant","content":"Let me inspect the SDK bridge."},
		{"role":"tool","content":"[session-activity: bash=ls]"},
		{"role":"user","content":"I work on mnemo."}
	]`)
	got := userTurnsToText(raw)
	if !strings.Contains(got, "I'm Tiago") || !strings.Contains(got, "I work on mnemo") {
		t.Fatalf("user content missing: %q", got)
	}
	if strings.Contains(got, "Let me inspect") || strings.Contains(got, "session-activity") {
		t.Fatalf("non-user content leaked into about input: %q", got)
	}
	// The literal "[user]" role label must not appear — it was itself a
	// source of about pollution.
	if strings.Contains(got, "[user]") {
		t.Fatalf("role label leaked: %q", got)
	}
}

func TestUserTurnsToTextEmptyWhenNoUserTurns(t *testing.T) {
	raw := json.RawMessage(`[{"role":"assistant","content":"hi"},{"role":"tool","content":"x"}]`)
	if got := userTurnsToText(raw); got != "" {
		t.Fatalf("want empty when no user turns, got %q", got)
	}
}

// When an event has no user turns (e.g. an assistant/tool-only slice), the
// about extractor must be skipped entirely — no biographical facts can come
// from the tooling talking to itself.
func TestExtractHandlerSkipsAboutWhenNoUserTurns(t *testing.T) {
	s, h, _ := setup(t)
	ctx := context.Background()
	tx, _ := s.DB.BeginTx(ctx, nil)
	rec, err := s.InsertEvent(ctx, tx, store.EventInput{
		ActorID:   "alice",
		SessionID: "s-nouser",
		Project:   "demo",
		Turns:     json.RawMessage(`[{"role":"assistant","content":"Let me inspect the bridge."},{"role":"tool","content":"[session-activity: bash=ls]"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: rec.EventID})
	if err := h.Handle(ctx, payload); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='about'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("about must be empty for an assistant/tool-only event, got %d rows", n)
	}
}

// When an event has no user turns (e.g. an assistant/tool-only slice), the
// preferences extractor must be skipped entirely — no preference can come
// from the tooling talking to itself. Mirrors
// TestExtractHandlerSkipsAboutWhenNoUserTurns.
func TestExtractHandlerSkipsPreferencesWhenNoUserTurns(t *testing.T) {
	s, h, _ := setup(t)
	ctx := context.Background()
	tx, _ := s.DB.BeginTx(ctx, nil)
	rec, err := s.InsertEvent(ctx, tx, store.EventInput{
		ActorID:   "alice",
		SessionID: "s-nouser-prefs",
		Project:   "demo",
		Turns:     json.RawMessage(`[{"role":"assistant","content":"Let me inspect the bridge."},{"role":"tool","content":"[session-activity: bash=ls]"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: rec.EventID})
	if err := h.Handle(ctx, payload); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='preferences'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("preferences must be empty for an assistant/tool-only event, got %d rows", n)
	}
}

// The preferences extractor must see only the actor's own turns, exactly
// like the about extractor (see userTurnsToText). A coding session is
// mostly assistant narration and tool output; feeding that to the
// preferences extractor is what produced records like "Manages
// authentication tokens proactively to ensure seamless tool operation" from
// the assistant's own debugging narration, not anything the user said about
// themselves.
func TestPreferencesExtractorOnlySeesUserTurns(t *testing.T) {
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

	var capturedPrefsInput string
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		user := ""
		if len(req.Messages) > 0 {
			user = req.Messages[0].Content
		}
		if req.System == SystemExtractPreferences {
			capturedPrefsInput = user
			return llm.CompleteResponse{Text: `{"preferences":[]}`}, nil
		}
		switch {
		case strings.Contains(user, "CLASSIFY THE TASK DOMAIN"):
			return llm.CompleteResponse{Text: "TASK: coding\nPROJECT_FACTS:\nNONE\nTASK_FACTS:\nNONE\nDAILY:\nNONE"}, nil
		case strings.Contains(user, "extracting biographical"):
			return llm.CompleteResponse{Text: "ABOUT:\nNONE"}, nil
		}
		return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[]}`}, nil
	}}
	h := &Handler{Store: s, LLM: stub, Model: "claude-test"}

	tx, _ := s.DB.BeginTx(ctx, nil)
	rec, err := s.InsertEvent(ctx, tx, store.EventInput{
		ActorID:   "alice",
		SessionID: "s-mixed",
		Project:   "demo",
		Turns: json.RawMessage(`[
			{"role":"user","content":"debug why the token refresh is failing"},
			{"role":"assistant","content":"Manages authentication tokens proactively to ensure seamless tool operation. Uses Docker multi-tagging strategy with both latest and SHA tags."}
		]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: rec.EventID})
	if err := h.Handle(ctx, payload); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(capturedPrefsInput, "Manages authentication tokens proactively") ||
		strings.Contains(capturedPrefsInput, "Docker multi-tagging strategy") {
		t.Fatalf("assistant narration leaked into preferences extractor input: %q", capturedPrefsInput)
	}
	if !strings.Contains(capturedPrefsInput, "debug why the token refresh is failing") {
		t.Fatalf("user's own turn missing from preferences extractor input: %q", capturedPrefsInput)
	}
}

func TestExtractHandlerEpisodesDisabled(t *testing.T) {
	s, h, evID := setup(t)
	if _, err := s.DB.Exec(`UPDATE actors SET episode_strategy='disabled' WHERE actor_id='alice'`); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: evID})
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='episodes'`).Scan(&n)
	if n != 0 {
		t.Fatalf("expected 0 episode rows when strategy=disabled, got %d", n)
	}
}

func TestExtractHandlerIdempotentOnRetry(t *testing.T) {
	s, h, evID := setup(t)
	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: evID})
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	// Run again — append-dim rows for this event should be deleted+re-inserted,
	// not duplicated. Consolidated dims use reinforce/keep so also should not duplicate.
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	// daily_log is append-dim: should have exactly 1 row (deleted+re-inserted on retry).
	var n int
	if err := s.DB.QueryRow(`SELECT count(*) FROM memories WHERE actor_id='alice' AND dimension='daily_log'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("daily_log after retry: want 1 got %d", n)
	}
}

func TestExtractHandlerReinforcementOnSecondEvent(t *testing.T) {
	s, h, evID := setup(t)
	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: evID})
	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatal(err)
	}

	// Get the memory ID of the inserted preference item.
	var memID string
	var count1 int
	if err := s.DB.QueryRow(`
		SELECT memory_id, reinforced_count FROM memories
		 WHERE actor_id='alice' AND dimension='preferences'
		 LIMIT 1
	`).Scan(&memID, &count1); err != nil {
		t.Fatal(err)
	}

	// Create a second event and configure the stub to reinforce the existing item.
	tx, _ := s.DB.BeginTx(context.Background(), nil)
	rec2, _ := s.InsertEvent(context.Background(), tx, store.EventInput{
		ActorID:   "alice",
		SessionID: "s2",
		Project:   "demo",
		Turns:     json.RawMessage(`[{"role":"user","content":"I still prefer Go for backends"}]`),
	})
	_ = tx.Commit()

	memUUID, _ := uuid.Parse(memID)
	h.LLM = &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		user := ""
		if len(req.Messages) > 0 {
			user = req.Messages[0].Content
		}
		switch {
		case strings.Contains(user, "CLASSIFY THE TASK DOMAIN"):
			return llm.CompleteResponse{Text: "TASK: coding\nPROJECT_FACTS:\nUses Go for backend services.\nTASK_FACTS:\nUses Go for backend services.\nDAILY:\nDiscussed Go preferences."}, nil
		case strings.Contains(user, "extracting biographical"):
			return llm.CompleteResponse{Text: "ABOUT:\nNONE"}, nil
		}
		switch {
		case strings.Contains(req.System, "PREFERENCES memory"):
			// Reinforce the existing item instead of inserting a new one.
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":["` + memUUID.String() + `"],"delete":[],"update":[],"insert":[]}`}, nil
		case strings.Contains(req.System, "PROJECT memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"Uses Go","tags":["architecture"]}]}`}, nil
		case strings.Contains(req.System, "TASK memory"):
			return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"Uses Go","tags":["pattern"]}]}`}, nil
		}
		switch req.System {
		case SystemExtractPreferences:
			return llm.CompleteResponse{Text: `{"preferences":["uses Go for backend services"]}`}, nil
		case SystemExtractEpisodes:
			return llm.CompleteResponse{Text: `{"episodes":[]}`}, nil
		}
		return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[]}`}, nil
	}}

	payload2, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: rec2.EventID})
	if err := h.Handle(context.Background(), payload2); err != nil {
		t.Fatal(err)
	}

	// Preferences row should have reinforced_count = 2.
	var count2 int
	if err := s.DB.QueryRow(`SELECT reinforced_count FROM memories WHERE memory_id=$1`, memID).Scan(&count2); err != nil {
		t.Fatal(err)
	}
	if count2 != 2 {
		t.Errorf("reinforced_count after second event: want 2 got %d", count2)
	}
}
