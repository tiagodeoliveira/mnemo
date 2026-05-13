package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Sweeper periodically deletes 'done' jobs older than retention.
func Sweeper(ctx context.Context, s *store.Store, logger *slog.Logger, retention time.Duration, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			res, err := s.DB.ExecContext(ctx, `
				DELETE FROM jobs WHERE state='done' AND completed_at < now() - $1::interval
			`, retention.String())
			if err != nil {
				logger.Warn("sweeper", "err", err)
				continue
			}
			n, _ := res.RowsAffected()
			if n > 0 {
				logger.Info("sweeper", "deleted", n)
			}
		}
	}
}
