package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAIComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer k1" {
			t.Errorf("bad authorization header: %q", r.Header.Get("authorization"))
		}
		b, _ := io.ReadAll(r.Body)
		var in openaiReq
		_ = json.Unmarshal(b, &in)
		if in.Model != "gpt-test" {
			t.Errorf("model: %s", in.Model)
		}
		// System field on CompleteRequest must be translated into a system-role message.
		if len(in.Messages) != 2 || in.Messages[0].Role != "system" || in.Messages[0].Content != "be terse" {
			t.Errorf("system not translated to message: %+v", in.Messages)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"role": "assistant", "content": "hi back"}, "finish_reason": "stop"},
			},
			"usage": map[string]any{"prompt_tokens": 7, "completion_tokens": 2},
		})
	}))
	defer srv.Close()

	o := &OpenAI{APIKey: "k1", Endpoint: srv.URL}
	out, err := o.Complete(context.Background(), CompleteRequest{
		Model:    "gpt-test",
		System:   "be terse",
		Messages: []Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "hi back" || out.StopReason != "stop" || out.OutputToks != 2 {
		t.Fatalf("out: %+v", out)
	}
}

func TestOpenAINon2xxBubblesStatusAndBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"too many"}`))
	}))
	defer srv.Close()
	o := &OpenAI{APIKey: "k", Endpoint: srv.URL}
	_, err := o.Complete(context.Background(), CompleteRequest{Model: "x"})
	if err == nil {
		t.Fatal("expected error on 429")
	}
	if got := err.Error(); !contains(got, "429") || !contains(got, "too many") {
		t.Fatalf("status+body not surfaced: %s", got)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
