package llm

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// fakeMetrics records every call so tests can assert on labels/values.
type fakeMetrics struct {
	reqs   []reqCall
	tokens []tokCall
}

type reqCall struct {
	provider, model, status string
	dur                     time.Duration
}
type tokCall struct {
	provider, model string
	input, output   int
}

func (f *fakeMetrics) RecordRequest(provider, model, status string, dur time.Duration) {
	f.reqs = append(f.reqs, reqCall{provider, model, status, dur})
}
func (f *fakeMetrics) RecordTokens(provider, model string, input, output int) {
	f.tokens = append(f.tokens, tokCall{provider, model, input, output})
}

func TestMeteredRecordsSuccessAndTokens(t *testing.T) {
	fm := &fakeMetrics{}
	inner := &stubClient{resp: CompleteResponse{Text: "hi", InputToks: 120, OutputToks: 30}}
	c := NewMetered("openai", inner, fm)

	_, err := c.Complete(context.Background(), CompleteRequest{Model: "gpt-x"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(fm.reqs) != 1 || fm.reqs[0].status != "ok" {
		t.Fatalf("expected one ok request, got %+v", fm.reqs)
	}
	if fm.reqs[0].provider != "openai" || fm.reqs[0].model != "gpt-x" {
		t.Fatalf("wrong request labels: %+v", fm.reqs[0])
	}
	if len(fm.tokens) != 1 {
		t.Fatalf("expected one token record, got %+v", fm.tokens)
	}
	if fm.tokens[0].input != 120 || fm.tokens[0].output != 30 {
		t.Fatalf("wrong token counts: %+v", fm.tokens[0])
	}
}

func TestMeteredSkipsTokensOnError(t *testing.T) {
	fm := &fakeMetrics{}
	inner := &stubClient{err: errors.New("boom")}
	c := NewMetered("anthropic", inner, fm)

	if _, err := c.Complete(context.Background(), CompleteRequest{Model: "m"}); err == nil {
		t.Fatal("expected error to propagate")
	}
	if len(fm.reqs) != 1 || fm.reqs[0].status != "error" {
		t.Fatalf("expected one error request, got %+v", fm.reqs)
	}
	if len(fm.tokens) != 0 {
		t.Fatalf("tokens must not be recorded on failure, got %+v", fm.tokens)
	}
}

func TestNewMeteredNilMetricsPassthrough(t *testing.T) {
	inner := &stubClient{resp: CompleteResponse{Text: "x"}}
	if got := NewMetered("openai", inner, nil); got != inner {
		t.Fatal("nil metrics must return inner unwrapped")
	}
}

// timeoutErr satisfies the net.Error-style Timeout() interface classifyStatus
// probes for.
type timeoutErr struct{}

func (timeoutErr) Error() string { return "i/o timeout" }
func (timeoutErr) Timeout() bool { return true }

func TestClassifyStatus(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"nil is ok", nil, "ok"},
		{"429 is rate_limited", &APIError{Provider: "openai", StatusCode: 429}, "rate_limited"},
		{"500 is error", &APIError{Provider: "openai", StatusCode: 500}, "error"},
		{"ctx deadline is timeout", context.DeadlineExceeded, "timeout"},
		{"net timeout is timeout", timeoutErr{}, "timeout"},
		{"wrapped 429 is rate_limited", fmt.Errorf("chain: %w", &APIError{StatusCode: 429}), "rate_limited"},
		{"generic is error", errors.New("nope"), "error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyStatus(tc.err); got != tc.want {
				t.Fatalf("classifyStatus(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}
