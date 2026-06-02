package observability

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// BreakerMetrics emits OTel metrics on every circuit-breaker state
// change. It satisfies the BreakerMetrics interface declared in
// any package that owns a breaker (llm.Chain, queue.Pool). One
// instance is safe to share across many breakers — the `name`
// argument identifies the source.
//
// Two metrics are emitted:
//
//   - circuit_breaker_open (Int64Gauge, labels: name) — 1 while open,
//     0 otherwise. Drives the CircuitBreakerOpen alert.
//   - circuit_breaker_transitions_total (Int64Counter, labels: name,
//     to_state ∈ {open, closed, half_open}) — counts state changes.
//
// The MeterProvider must be registered as the global before
// NewBreakerMetrics runs (observability.InitMetrics handles that).
// Built with the global meter rather than an injected one because
// the OTel SDK already supports concurrent meter creation against
// the global provider and we don't gain anything by threading a
// MeterProvider through every package.
type BreakerMetrics struct {
	openGauge   metric.Int64Gauge
	transitions metric.Int64Counter
}

func NewBreakerMetrics() *BreakerMetrics {
	meter := otel.Meter("mnemo/circuit_breaker")
	openGauge, _ := meter.Int64Gauge(
		"circuit_breaker_open",
		metric.WithDescription("1 when the named breaker is open, 0 otherwise"),
	)
	transitions, _ := meter.Int64Counter(
		"circuit_breaker_transitions_total",
		metric.WithDescription("Count of circuit-breaker state transitions"),
	)
	return &BreakerMetrics{openGauge: openGauge, transitions: transitions}
}

// Transition records a single state change. `toState` must be one of
// "open", "closed", "half_open" — the breaker owner is responsible
// for normalizing internal state names to that vocabulary.
//
// Uses context.Background because metric writes are decoupled from
// the request context; an instrument record that fails to enqueue
// because of a dead request context would be a worse failure mode
// than dropping it silently.
func (m *BreakerMetrics) Transition(name, toState string) {
	if m == nil {
		return
	}
	nameAttr := attribute.String("name", name)
	open := int64(0)
	if toState == "open" {
		open = 1
	}
	m.openGauge.Record(context.Background(), open, metric.WithAttributes(nameAttr))
	m.transitions.Add(context.Background(), 1, metric.WithAttributes(
		nameAttr,
		attribute.String("to_state", toState),
	))
}
