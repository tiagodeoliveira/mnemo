package queue

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// retryDBOp runs op up to 3 times with exponential backoff (500ms/1s/2s).
// Respects ctx cancellation.
func retryDBOp(ctx context.Context, op func() error) error {
	backoffs := []time.Duration{500 * time.Millisecond, 1 * time.Second, 2 * time.Second}
	var lastErr error
	for i, b := range backoffs {
		if err := op(); err == nil {
			return nil
		} else {
			lastErr = err
		}
		// Don't sleep after the last attempt.
		if i == len(backoffs)-1 {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(b):
		}
	}
	return lastErr
}

// completeWithRetry tries CompleteJob up to 3 times with exponential backoff.
// Logs an ERROR on persistent failure — the lock stays held until next boot's
// ReclaimStaleJobs releases it.
func (p *Pool) completeWithRetry(ctx context.Context, jobID int64) {
	if err := retryDBOp(ctx, func() error {
		return p.store.CompleteJob(ctx, jobID)
	}); err != nil {
		p.logger.Error("CompleteJob persistently failed — lock will be reclaimed on next boot",
			"job_id", jobID, "err", err)
	}
}

// failWithRetry tries FailJob up to 3 times with exponential backoff.
// Logs an ERROR on persistent failure — the lock stays held until next boot's
// ReclaimStaleJobs releases it.
func (p *Pool) failWithRetry(ctx context.Context, jobID int64, attempts int, errMsg string, runAfterSec int, maxAttempts int) {
	if err := retryDBOp(ctx, func() error {
		return p.store.FailJob(ctx, jobID, attempts, errMsg, runAfterSec, maxAttempts)
	}); err != nil {
		p.logger.Error("FailJob persistently failed — lock will be reclaimed on next boot",
			"job_id", jobID, "err", err)
	}
}

// Handler processes one job's payload. Idempotent on retry.
type Handler func(ctx context.Context, payload json.RawMessage) error

type Pool struct {
	store    *store.Store
	logger   *slog.Logger
	workers  int
	handlers map[store.JobKind]Handler
}

func NewPool(s *store.Store, logger *slog.Logger, workers int, handlers map[store.JobKind]Handler) *Pool {
	return &Pool{store: s, logger: logger, workers: workers, handlers: handlers}
}

// Run blocks until ctx is done. Returns after all workers drain.
func (p *Pool) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < p.workers; i++ {
		wg.Add(1)
		workerID := wfmt(i)
		go func() {
			defer wg.Done()
			p.loop(ctx, workerID)
		}()
	}
	wg.Wait()
}

func wfmt(i int) string {
	return "w-" + time.Now().UTC().Format("0405") + "-" + string(rune('0'+i))
}

func (p *Pool) loop(ctx context.Context, id string) {
	for {
		if ctx.Err() != nil {
			return
		}
		j, err := p.store.ClaimJob(ctx, id)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			p.logger.Error("claim", "worker", id, "err", err)
			sleepJitter(ctx, time.Second, 5*time.Second)
			continue
		}
		if j == nil {
			sleepJitter(ctx, time.Second, 5*time.Second)
			continue
		}
		h, ok := p.handlers[j.Kind]
		if !ok {
			known := make([]string, 0, len(p.handlers))
			for k := range p.handlers {
				known = append(known, string(k))
			}
			p.logger.Error("no handler for kind",
				"worker", id, "kind", string(j.Kind), "kind_len", len(j.Kind),
				"known", known, "known_count", len(p.handlers))
			p.failWithRetry(ctx, j.JobID, j.Attempts, "no handler for kind: "+string(j.Kind), 0, 1)
			continue
		}
		stopHB := p.heartbeat(ctx, j.JobID)
		err = h(ctx, j.Payload)
		stopHB()

		if err != nil {
			p.logger.Warn("job failed", "worker", id, "kind", j.Kind, "job_id", j.JobID, "attempts", j.Attempts, "err", err)
			p.failWithRetry(ctx, j.JobID, j.Attempts, err.Error(), BackoffSeconds(j.Attempts), MaxAttempts)
			continue
		}
		p.completeWithRetry(ctx, j.JobID)
	}
}

func sleepJitter(ctx context.Context, lo, hi time.Duration) {
	d := lo + time.Duration(rand.Int64N(int64(hi-lo)))
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// heartbeat keeps a job's locked_at fresh while the handler runs.
// Returns a cancel function. The goroutine exits when cancel() is called
// or ctx is done.
//
// stopHB must be called BEFORE FailJob/CompleteJob so the heartbeat goroutine
// doesn't race with the state transition.
func (p *Pool) heartbeat(ctx context.Context, jobID int64) (cancel func()) {
	stopCh := make(chan struct{})
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				_, err := p.store.DB.ExecContext(ctx,
					`UPDATE jobs SET locked_at = now()
					  WHERE job_id = $1 AND state = 'running'`, jobID)
				if err != nil {
					p.logger.Warn("heartbeat update failed", "job_id", jobID, "err", err)
				}
			}
		}
	}()
	return func() {
		select {
		case <-stopCh:
		default:
			close(stopCh)
		}
	}
}
