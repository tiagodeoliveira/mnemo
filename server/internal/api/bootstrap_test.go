package api

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

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func setupBootstrapTestServer(t *testing.T) *httptest.Server {
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
	return srv
}

func TestBootstrapAcceptsDocument(t *testing.T) {
	srv := setupBootstrapTestServer(t)

	body, _ := json.Marshal(map[string]any{
		"source":  "README.md",
		"project": "mnemo",
		"content": "First paragraph about A.\n\nSecond paragraph about B.\n\nThird paragraph about C.",
	})
	resp, err := http.Post(srv.URL+"/bootstrap", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusAccepted {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 202, got %d: %s", resp.StatusCode, string(raw))
	}
	var out bootstrapResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.ChunkCount != 1 {
		t.Fatalf("small content should produce 1 chunk, got %d", out.ChunkCount)
	}
	if len(out.EventIDs) != 1 {
		t.Fatalf("expected 1 event_id, got %d", len(out.EventIDs))
	}
}

func TestBootstrapChunksLargeDocument(t *testing.T) {
	srv := setupBootstrapTestServer(t)

	// Build a document with 10 paragraphs, each ~500 chars, separated by \n\n.
	// Total ~5000 chars → should chunk into ~2 chunks at the 3000-char target.
	var content strings.Builder
	for i := 0; i < 10; i++ {
		content.WriteString(strings.Repeat("paragraph word ", 30))
		if i < 9 {
			content.WriteString("\n\n")
		}
	}
	body, _ := json.Marshal(map[string]any{
		"source":  "long.md",
		"content": content.String(),
	})
	resp, err := http.Post(srv.URL+"/bootstrap", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusAccepted {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 202, got %d: %s", resp.StatusCode, string(raw))
	}
	var out bootstrapResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.ChunkCount < 2 {
		t.Fatalf("expected ≥2 chunks for ~5KB content, got %d", out.ChunkCount)
	}
	if len(out.EventIDs) != out.ChunkCount {
		t.Fatalf("event_ids should match chunk_count; got %d vs %d", len(out.EventIDs), out.ChunkCount)
	}
}

func TestBootstrapEmptyContent(t *testing.T) {
	srv := setupBootstrapTestServer(t)

	body, _ := json.Marshal(map[string]any{"content": "   "})
	resp, err := http.Post(srv.URL+"/bootstrap", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestBootstrapContentTooLarge(t *testing.T) {
	srv := setupBootstrapTestServer(t)

	big := strings.Repeat("x", bootstrapMaxContent+1)
	body, _ := json.Marshal(map[string]any{"content": big})
	resp, err := http.Post(srv.URL+"/bootstrap", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestChunkDocumentPacksParagraphs(t *testing.T) {
	doc := "a\n\nb\n\nc\n\nd"
	chunks := chunkDocument(doc, 100) // target large enough to fit all
	if len(chunks) != 1 {
		t.Fatalf("small doc within target should be 1 chunk, got %d", len(chunks))
	}
	if !strings.Contains(chunks[0], "a") || !strings.Contains(chunks[0], "d") {
		t.Fatalf("chunk missing content: %q", chunks[0])
	}
}

func TestChunkDocumentSplitsAtBoundaries(t *testing.T) {
	// Two ~50-char paragraphs with a 60-char target should land in 2 chunks.
	p1 := strings.Repeat("x", 50)
	p2 := strings.Repeat("y", 50)
	chunks := chunkDocument(p1+"\n\n"+p2, 60)
	if len(chunks) != 2 {
		t.Fatalf("want 2 chunks, got %d", len(chunks))
	}
	if chunks[0] != p1 {
		t.Fatalf("chunk 0 = %q, want %q", chunks[0], p1)
	}
	if chunks[1] != p2 {
		t.Fatalf("chunk 1 = %q, want %q", chunks[1], p2)
	}
}

func TestChunkDocumentSkipsBlankParagraphs(t *testing.T) {
	chunks := chunkDocument("a\n\n\n\n\n\nb", 100)
	if len(chunks) != 1 {
		t.Fatalf("blanks should be skipped, got %d chunks", len(chunks))
	}
	if !strings.Contains(chunks[0], "a") || !strings.Contains(chunks[0], "b") {
		t.Fatalf("chunk missing content: %q", chunks[0])
	}
}
