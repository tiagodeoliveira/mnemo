package observability

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// WorkerMetrics emits a single counter per job outcome so every
// failure (and every success) lands in Prometheus. Bounded cardinality:
// `job_type` is one of a handful of registered kinds, and `status`
// is one of three.
//
// Metric: worker_jobs_total (Int64Counter, labels: job_type, status).
// `status` vocabulary: "ok" | "error" | "circuit_open" — the last is
// emitted when the per-kind breaker refused a claim so callers can
// distinguish "broken handler" from "kind in cooldown" without
// reading slog.
type WorkerMetrics struct {
	jobs metric.Int64Counter
}

func NewWorkerMetrics() *WorkerMetrics {
	meter := otel.Meter("mnemo/worker")
	jobs, _ := meter.Int64Counter(
		"worker_jobs_total",
		metric.WithDescription("Count of background-job outcomes by kind and status"),
	)
	return &WorkerMetrics{jobs: jobs}
}

// RecordJob bumps the counter for a single job outcome.
func (m *WorkerMetrics) RecordJob(jobType, status string) {
	if m == nil {
		return
	}
	m.jobs.Add(context.Background(), 1, metric.WithAttributes(
		attribute.String("job_type", jobType),
		attribute.String("status", status),
	))
}
