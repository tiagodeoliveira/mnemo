package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func setupEventsTestServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(NewRouter(Deps{
		Store:         s,
		Logger:        logger,
		EmbedClient:   &embed.Stub{},
		EmbedDisabled: true,
		DevActorID:    "alice",
	}))
	t.Cleanup(srv.Close)
	return srv, s
}

// countJobs returns how many pending jobs of the given kind exist.
func countJobs(t *testing.T, s *store.Store, kind store.JobKind) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRowContext(context.Background(),
		`SELECT count(*) FROM jobs WHERE kind = $1`, string(kind),
	).Scan(&n); err != nil {
		t.Fatalf("count jobs %s: %v", kind, err)
	}
	return n
}

func postEvent(t *testing.T, srv *httptest.Server, body map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	resp, err := http.Post(srv.URL+"/events", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusAccepted {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 202, got %d: %s", resp.StatusCode, string(out))
	}
}

// A meeting transcript event must NOT be routed to the single-actor
// extract_context fan-out — those extractors (about/preferences/episodes)
// are meaning-less on multi-speaker diarized transcript and pollute the
// about dimension with speaker-labeled lines. Meeting content is handled
// by the dedicated finalize_meeting path instead.
func TestEventsMeetingSkipsExtractContext(t *testing.T) {
	srv, s := setupEventsTestServer(t)

	postEvent(t, srv, map[string]any{
		"session_id": "sess-1",
		"turns": []map[string]string{
			{"role": "Speaker 1", "content": "Where is he?"},
			{"role": "Speaker 2", "content": "He's not coming."},
		},
		"attributes": map[string]any{"meeting_id": "standup", "meeting_ended": true},
	})

	if got := countJobs(t, s, store.KindExtractContext); got != 0 {
		t.Fatalf("meeting event must not enqueue extract_context, got %d", got)
	}
	if got := countJobs(t, s, store.KindFinalizeMeeting); got != 1 {
		t.Fatalf("meeting-ended event must enqueue exactly one finalize_meeting, got %d", got)
	}
}

// A meeting chunk that is not the final one (meeting_ended=false) still
// belongs to a meeting, so it must skip extract_context too.
func TestEventsMidMeetingChunkSkipsExtractContext(t *testing.T) {
	srv, s := setupEventsTestServer(t)

	postEvent(t, srv, map[string]any{
		"session_id": "sess-1",
		"turns":      []map[string]string{{"role": "Speaker 1", "content": "ongoing"}},
		"attributes": map[string]any{"meeting_id": "standup", "meeting_ended": false},
	})

	if got := countJobs(t, s, store.KindExtractContext); got != 0 {
		t.Fatalf("mid-meeting chunk must not enqueue extract_context, got %d", got)
	}
	if got := countJobs(t, s, store.KindFinalizeMeeting); got != 0 {
		t.Fatalf("non-final chunk must not enqueue finalize_meeting, got %d", got)
	}
}

// A normal (non-meeting) event must still be extracted as before.
func TestEventsNonMeetingEnqueuesExtractContext(t *testing.T) {
	srv, s := setupEventsTestServer(t)

	postEvent(t, srv, map[string]any{
		"session_id": "sess-1",
		"project":    "mnemo",
		"turns":      []map[string]string{{"role": "user", "content": "I'm a Go engineer."}},
	})

	if got := countJobs(t, s, store.KindExtractContext); got != 1 {
		t.Fatalf("normal event must enqueue exactly one extract_context, got %d", got)
	}
	if got := countJobs(t, s, store.KindFinalizeMeeting); got != 0 {
		t.Fatalf("normal event must not enqueue finalize_meeting, got %d", got)
	}
}
