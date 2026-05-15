package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Reaper releases locks on rows whose locked_at is older than threshold,
// indicating the worker holding them has died or stalled. Runs only on
// the instance that holds LockKeyReaper.
//
// threshold should be at least 3× the worker heartbeat interval to avoid
// reaping live workers under transient DB lag.
type Reaper struct {
	Store     *store.Store
	Logger    *slog.Logger
	Threshold time.Duration // e.g. 90 * time.Second
	Interval  time.Duration // e.g. 60 * time.Second
}

func (r *Reaper) Run(ctx context.Context) {
	interval := r.Interval
	if interval <= 0 {
		interval = 60 * time.Second
	}
	threshold := r.Threshold
	if threshold <= 0 {
		threshold = 90 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := r.Store.ReleaseStaleLocks(ctx, threshold)
			if err != nil {
				r.Logger.Warn("reaper: release stale locks failed", "err", err)
				continue
			}
			if n > 0 {
				r.Logger.Info("reaper: released stale running locks", "count", n, "threshold", threshold)
			}
		}
	}
}
