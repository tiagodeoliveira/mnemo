package embed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAIEmbedHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer test-key" {
			t.Errorf("bad auth header")
		}
		var body openAIReq
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "text-embedding-3-small" || len(body.Input) != 2 {
			t.Errorf("unexpected request: %+v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"index": 0, "embedding": make([]float32, defaultOpenAIDimensions)},
				{"index": 1, "embedding": make([]float32, defaultOpenAIDimensions)},
			},
			"usage": map[string]int{"prompt_tokens": 10},
		})
	}))
	defer srv.Close()

	c := &OpenAI{APIKey: "test-key", Endpoint: srv.URL}
	resp, err := c.Embed(context.Background(), EmbedRequest{Texts: []string{"a", "b"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Vectors) != 2 {
		t.Fatalf("want 2 vectors, got %d", len(resp.Vectors))
	}
	if resp.TokensUsed != 10 {
		t.Fatalf("tokens: %d", resp.TokensUsed)
	}
}

func TestOpenAIEmbedEmptyInput(t *testing.T) {
	c := &OpenAI{APIKey: "test-key"}
	resp, err := c.Embed(context.Background(), EmbedRequest{Texts: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Vectors) != 0 {
		t.Fatalf("expected 0 vectors for empty input")
	}
}
