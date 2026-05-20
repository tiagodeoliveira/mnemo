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

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func TestSearchEndpoint(t *testing.T) {
	dsn := store.StartTestPG(t)
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

	stubEmbed := &embed.Stub{}

	// Pre-compute embeddings for two items using the stub.
	contents := []string{"uses Go for backend services", "prefers tabs over spaces"}
	embResp, err := stubEmbed.Embed(ctx, embed.EmbedRequest{Texts: contents})
	if err != nil {
		t.Fatal(err)
	}

	// Insert items with their stub embeddings.
	eventID := uuid.New()
	tx, _ := s.DB.BeginTx(ctx, nil)
	for i, content := range contents {
		id := uuid.New()
		if _, execErr := tx.ExecContext(ctx, `
			INSERT INTO memories (
				memory_id, actor_id, dimension, namespace, content,
				tags, attributes, source_event_ids, reinforced_count, embedding
			) VALUES ($1, 'alice', 'preferences', '/preferences/alice/', $2,
			          '[]', '{}', ARRAY[$3::uuid], 1, $4)
		`, id, content, eventID, pgvector.NewVector(embResp.Vectors[i])); execErr != nil {
			_ = tx.Rollback()
			t.Fatalf("insert: %v", execErr)
		}
	}
	_ = tx.Commit()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := NewRouter(Deps{
		Store:         s,
		Logger:        logger,
		EmbedClient:   stubEmbed,
		EmbedDisabled: false,
		DevActorID:    "alice",
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	// POST /search with a query. DevActorID="alice" maps all requests to alice. The stub embed is deterministic — querying
	// "uses Go for backend services" should return the exact match as top hit.
	body, _ := json.Marshal(map[string]any{
		"q":     "uses Go for backend services",
		"limit": 5,
	})
	resp, err := http.Post(srv.URL+"/search", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, string(raw))
	}

	var result searchResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(result.Results) == 0 {
		t.Fatal("expected at least one result")
	}
	if result.Results[0].Content != "uses Go for backend services" {
		t.Errorf("expected top result to be 'uses Go for backend services', got %q (similarity=%f)",
			result.Results[0].Content, result.Results[0].Similarity)
	}
}

func TestSearchEndpointDisabled(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &searchHandler{
		embedDisabled: true,
		logger:        logger,
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/search", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d", rr.Code)
	}
}

func TestSearchEndpointMissingQ(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &searchHandler{
		embedClient:   &embed.Stub{},
		embedDisabled: false,
		logger:        logger,
	}
	body, _ := json.Marshal(map[string]any{"dimensions": []string{"preferences"}})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/search", bytes.NewReader(body)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rr.Code)
	}
}

func TestSearchEndpointBadDate(t *testing.T) {
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
		EmbedDisabled: false,
		DevActorID:    "alice",
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	cases := []struct {
		name  string
		since string
		until string
	}{
		{"bad since", "not-a-date", ""},
		{"bad until", "", "2024-13-01"},
		{"bad month", "2024-00-15", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"q":     "test query",
				"since": tc.since,
				"until": tc.until,
			})
			resp, err := http.Post(srv.URL+"/search", "application/json", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				raw, _ := io.ReadAll(resp.Body)
				t.Fatalf("want 400, got %d: %s", resp.StatusCode, string(raw))
			}
		})
	}
}
