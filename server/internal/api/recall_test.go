package api

import (
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

func TestRecallBadDateReturns400(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := NewRouter(Deps{
		Store:         s,
		Logger:        logger,
		EmbedClient:   &embed.Stub{},
		EmbedDisabled: true,
		DevActorID:    "alice",
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	cases := []struct {
		name  string
		query string
	}{
		{"bad since", "?preferences=1&since=not-a-date"},
		{"bad until", "?preferences=1&until=2024-13-01"},
		{"bad since on recall", "?episodes=1&since=yesterday"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Get(srv.URL + "/recall" + tc.query)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("want 400, got %d: %s", resp.StatusCode, string(body))
			}
		})
	}
}

func TestRecallEmptyDimensions(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := NewRouter(Deps{
		Store:         s,
		Logger:        logger,
		EmbedClient:   &embed.Stub{},
		EmbedDisabled: true,
		DevActorID:    "alice",
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	// No dimension params → empty response, not an error.
	resp, err := http.Get(srv.URL + "/recall")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	dims, ok := result["dimensions"].([]any)
	if !ok {
		t.Fatal("missing dimensions key")
	}
	if len(dims) != 0 {
		t.Fatalf("expected empty dimensions, got %d", len(dims))
	}
}

func TestRecallHappyPath(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := NewRouter(Deps{
		Store:         s,
		Logger:        logger,
		EmbedClient:   &embed.Stub{},
		EmbedDisabled: true,
		DevActorID:    "alice",
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	// Request preferences (will be empty but valid).
	resp, err := http.Get(srv.URL + "/recall?preferences=1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 200, got %d: %s", resp.StatusCode, string(body))
	}

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	dims, ok := result["dimensions"].([]any)
	if !ok || len(dims) == 0 {
		t.Fatal("expected non-empty dimensions array")
	}
}
