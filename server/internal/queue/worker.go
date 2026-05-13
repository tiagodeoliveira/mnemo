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
			_ = p.store.FailJob(ctx, j.JobID, j.Attempts, "no handler for kind: "+string(j.Kind), 0, 1)
			continue
		}
		if err := h(ctx, j.Payload); err != nil {
			p.logger.Warn("job failed", "worker", id, "kind", j.Kind, "job_id", j.JobID, "attempts", j.Attempts, "err", err)
			_ = p.store.FailJob(ctx, j.JobID, j.Attempts, err.Error(), BackoffSeconds(j.Attempts), MaxAttempts)
			continue
		}
		_ = p.store.CompleteJob(ctx, j.JobID)
	}
}

func sleepJitter(ctx context.Context, lo, hi time.Duration) {
	d := lo + time.Duration(rand.Int64N(int64(hi-lo)))
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
