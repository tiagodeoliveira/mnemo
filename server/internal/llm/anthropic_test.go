package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnthropicComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "k1" || r.Header.Get("anthropic-version") != anthropicVersion {
			t.Errorf("bad headers: %v", r.Header)
		}
		b, _ := io.ReadAll(r.Body)
		var in anthropicReq
		_ = json.Unmarshal(b, &in)
		if in.Model != "claude-test" {
			t.Errorf("model: %s", in.Model)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":     []map[string]any{{"type": "text", "text": "hello"}},
			"stop_reason": "end_turn",
			"usage":       map[string]any{"input_tokens": 5, "output_tokens": 1},
		})
	}))
	defer srv.Close()

	a := &Anthropic{APIKey: "k1", Endpoint: srv.URL}
	out, err := a.Complete(context.Background(), CompleteRequest{
		Model: "claude-test", Messages: []Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "hello" || out.OutputToks != 1 {
		t.Fatalf("out: %+v", out)
	}
}
