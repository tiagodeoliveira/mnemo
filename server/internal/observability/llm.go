package observability

import (
	"context"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// LLMMetrics emits the LLM request metrics the alert rules read:
//
//   - llm_request_duration_seconds (Float64Histogram, labels: provider,
//     model, status) — wall-clock latency of one provider call.
//   - llm_tokens_used_total (Int64Counter, labels: provider, model,
//     direction ∈ {input, output}) — tokens from the provider's usage block,
//     recorded only on a successful call.
//
// Cardinality is bounded: provider is a handful of names, model a small fixed
// set, status the four-value vocabulary, direction binary.
//
// It satisfies the llm.LLMMetrics interface; one instance is shared across
// every provider wrapper. nil-safe like the other emitters in this package,
// so a failed InitMetrics (no-op global provider) degrades cleanly.
type LLMMetrics struct {
	duration metric.Float64Histogram
	tokens   metric.Int64Counter
}

func NewLLMMetrics() *LLMMetrics {
	meter := otel.Meter("mnemo/llm")
	// Explicit boundaries (seconds): the OTel default buckets top out at the
	// scale where this metric starts. LLM calls run ~0.2s (small extraction)
	// to the 300s provider client timeout, so we need coarse buckets out to
	// 300 or every real call piles into the last default bucket and p99 is
	// meaningless.
	duration, _ := meter.Float64Histogram(
		"llm_request_duration_seconds",
		metric.WithDescription("Wall-clock duration of one LLM provider call, in seconds"),
		metric.WithExplicitBucketBoundaries(0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300),
	)
	tokens, _ := meter.Int64Counter(
		"llm_tokens_used_total",
		metric.WithDescription("LLM tokens consumed, by direction (input/output)"),
	)
	return &LLMMetrics{duration: duration, tokens: tokens}
}

// RecordRequest observes one provider call's latency and outcome.
//
// Uses context.Background because a metric write must not be tied to the
// (possibly already-cancelled) request context — dropping the observation
// because the call timed out would lose exactly the data point we most want.
func (m *LLMMetrics) RecordRequest(provider, model, status string, dur time.Duration) {
	if m == nil {
		return
	}
	m.duration.Record(context.Background(), dur.Seconds(), metric.WithAttributes(
		attribute.String("provider", provider),
		attribute.String("model", model),
		attribute.String("status", status),
	))
}

// RecordTokens adds input and output token counts as two points on the same
// counter, distinguished by the direction label.
func (m *LLMMetrics) RecordTokens(provider, model string, input, output int) {
	if m == nil {
		return
	}
	m.tokens.Add(context.Background(), int64(input), metric.WithAttributes(
		attribute.String("provider", provider),
		attribute.String("model", model),
		attribute.String("direction", "input"),
	))
	m.tokens.Add(context.Background(), int64(output), metric.WithAttributes(
		attribute.String("provider", provider),
		attribute.String("model", model),
		attribute.String("direction", "output"),
	))
}
