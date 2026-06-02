package queue

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// fakeWorkerMetrics records every RecordJob call.
type fakeWorkerMetrics struct {
	mu     sync.Mutex
	events []struct{ kind, status string }
}

func (f *fakeWorkerMetrics) RecordJob(kind, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, struct{ kind, status string }{kind, status})
}

func (f *fakeWorkerMetrics) snapshot() []struct{ kind, status string } {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]struct{ kind, status string }, len(f.events))
	copy(out, f.events)
	return out
}

func (f *fakeWorkerMetrics) countStatus(status string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, e := range f.events {
		if e.status == status {
			n++
		}
	}
	return n
}

// breakerMetricsTap captures breaker transitions; satisfies llm.BreakerMetrics.
type breakerMetricsTap struct {
	mu     sync.Mutex
	events []struct{ name, state string }
}

func (t *breakerMetricsTap) Transition(name, toState string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.events = append(t.events, struct{ name, state string }{name, toState})
}

func (t *breakerMetricsTap) snapshot() []struct{ name, state string } {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]struct{ name, state string }, len(t.events))
	copy(out, t.events)
	return out
}

// enqueueTestJob inserts a pending job ready to be claimed immediately.
func enqueueTestJob(t *testing.T, s *store.Store, kind store.JobKind) int64 {
	t.Helper()
	var id int64
	if err := s.DB.QueryRow(`
		INSERT INTO jobs (kind, payload, state, run_after, attempts)
		VALUES ($1, '{}'::jsonb, 'pending', now() - interval '1 second', 0)
		RETURNING job_id
	`, string(kind)).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// runPoolBriefly starts the pool, lets it drain, then cancels.
func runPoolBriefly(t *testing.T, pool *Pool, settle time.Duration) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { pool.Run(ctx); close(done) }()
	time.Sleep(settle)
	cancel()
	<-done
}

func TestPoolRecordsOkOnSuccess(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()

	enqueueTestJob(t, s, store.KindExtractContext)
	enqueueTestJob(t, s, store.KindExtractContext)

	metrics := &fakeWorkerMetrics{}
	handlers := map[store.JobKind]Handler{
		store.KindExtractContext: func(ctx context.Context, _ json.RawMessage) error { return nil },
	}
	pool := NewPool(s, slog.New(slog.NewTextHandler(io.Discard, nil)), handlers, PoolConfig{
		Workers:          1,
		BreakerThreshold: 10,
		BreakerCooldown:  time.Hour,
		WorkerMetrics:    metrics,
	})
	runPoolBriefly(t, pool, 2*time.Second)

	if got := metrics.countStatus("ok"); got != 2 {
		t.Fatalf("want 2 ok events, got %d (full: %+v)", got, metrics.snapshot())
	}
	if got := metrics.countStatus("error"); got != 0 {
		t.Fatalf("expected no error events, got %d", got)
	}
}

func TestPoolRecordsErrorOnFailure(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()
	enqueueTestJob(t, s, store.KindExtractContext)

	metrics := &fakeWorkerMetrics{}
	calls := atomic.Int32{}
	handlers := map[store.JobKind]Handler{
		store.KindExtractContext: func(ctx context.Context, _ json.RawMessage) error {
			calls.Add(1)
			return errors.New("boom")
		},
	}
	// Threshold high enough that one failure doesn't trip the breaker — we want
	// to confirm the "error" status is recorded independently of breaker state.
	pool := NewPool(s, slog.New(slog.NewTextHandler(io.Discard, nil)), handlers, PoolConfig{
		Workers:          1,
		BreakerThreshold: 10,
		BreakerCooldown:  time.Hour,
		WorkerMetrics:    metrics,
	})
	runPoolBriefly(t, pool, 2*time.Second)

	if got := metrics.countStatus("error"); got < 1 {
		t.Fatalf("want at least 1 error event, got %d (full: %+v)", got, metrics.snapshot())
	}
}

func TestPoolBreakerOpensAfterRepeatedFailures(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()

	// Enqueue more jobs than the threshold so the first few trip the breaker
	// and subsequent ones get short-circuited.
	const threshold = 3
	for i := 0; i < threshold+3; i++ {
		enqueueTestJob(t, s, store.KindExtractContext)
	}

	breakerTap := &breakerMetricsTap{}
	workerTap := &fakeWorkerMetrics{}
	handlers := map[store.JobKind]Handler{
		store.KindExtractContext: func(ctx context.Context, _ json.RawMessage) error {
			return errors.New("always broken")
		},
	}
	pool := NewPool(s, slog.New(slog.NewTextHandler(io.Discard, nil)), handlers, PoolConfig{
		Workers:          1,
		BreakerThreshold: threshold,
		BreakerCooldown:  time.Hour,
		BreakerMetrics:   breakerTap,
		WorkerMetrics:    workerTap,
	})
	runPoolBriefly(t, pool, 3*time.Second)

	// At least one "open" transition for worker.extract_context.
	sawOpen := false
	for _, ev := range breakerTap.snapshot() {
		if ev.name == "worker.extract_context" && ev.state == "open" {
			sawOpen = true
			break
		}
	}
	if !sawOpen {
		t.Fatalf("breaker never opened: events=%+v", breakerTap.snapshot())
	}

	// And we should see at least one circuit_open event in the worker counter
	// once the breaker tripped — proving the gate actually blocked claims.
	if got := workerTap.countStatus("circuit_open"); got < 1 {
		t.Fatalf("expected at least one circuit_open event, got %d (full: %+v)", got, workerTap.snapshot())
	}
}

func TestPoolNilMetricsIsSafe(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()
	enqueueTestJob(t, s, store.KindExtractContext)

	handlers := map[store.JobKind]Handler{
		store.KindExtractContext: func(ctx context.Context, _ json.RawMessage) error { return nil },
	}
	pool := NewPool(s, slog.New(slog.NewTextHandler(io.Discard, nil)), handlers, PoolConfig{
		Workers:          1,
		BreakerThreshold: 10,
		BreakerCooldown:  time.Hour,
		// BreakerMetrics + WorkerMetrics intentionally nil
	})
	// Should not panic.
	runPoolBriefly(t, pool, 2*time.Second)
}

