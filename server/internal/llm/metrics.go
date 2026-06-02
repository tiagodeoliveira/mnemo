package llm

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// LLMMetrics receives one observation per provider Complete() call so a
// metrics emitter (or a test fake) can record request latency, outcome, and
// token usage. Implementations MUST be safe for concurrent use. Pass nil to
// NewMetered to opt out.
//
// status is one of "ok", "error", "timeout", "rate_limited" — the fixed
// vocabulary the alert rules expect. Token counts come from the provider's
// usage block and are only recorded on a successful call.
type LLMMetrics interface {
	RecordRequest(provider, model, status string, dur time.Duration)
	RecordTokens(provider, model string, input, output int)
}

// metered wraps a single provider Client, timing each call and reporting the
// outcome to LLMMetrics. It carries the provider's name because the wrapped
// Client doesn't know its own metric label — the name is assigned in
// buildLLMProviders. Wrapping per-provider rather than once around the Chain
// means single-provider deployments (which bypass the Chain) are instrumented
// too.
type metered struct {
	provider string
	inner    Client
	metrics  LLMMetrics
}

// NewMetered wraps inner so each Complete() call emits metrics under the given
// provider label. Returns inner unchanged when metrics is nil, so callers can
// wire it unconditionally.
func NewMetered(provider string, inner Client, metrics LLMMetrics) Client {
	if metrics == nil {
		return inner
	}
	return &metered{provider: provider, inner: inner, metrics: metrics}
}

func (m *metered) Complete(ctx context.Context, req CompleteRequest) (CompleteResponse, error) {
	start := time.Now()
	resp, err := m.inner.Complete(ctx, req)
	dur := time.Since(start)

	// req.Model is the model actually sent: the Chain rewrites it to the
	// per-provider model before delegating, so this is the right label in
	// both chain and single-provider modes.
	m.metrics.RecordRequest(m.provider, req.Model, classifyStatus(err), dur)
	if err == nil {
		m.metrics.RecordTokens(m.provider, req.Model, resp.InputToks, resp.OutputToks)
	}
	return resp, err
}

// classifyStatus maps a Complete() error onto the status label vocabulary.
// Order matters: a context deadline can surface wrapped in a *url.Error whose
// Timeout() is true, so the net.Error check catches both the http.Client
// timeout and the ctx-deadline cases before the generic fallthrough.
func classifyStatus(err error) string {
	if err == nil {
		return "ok"
	}
	var netErr interface{ Timeout() bool }
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusTooManyRequests {
		return "rate_limited"
	}
	return "error"
}
