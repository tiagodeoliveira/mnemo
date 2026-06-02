package digest

import (
	"context"
	"log/slog"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Scheduler wakes every minute. For each digest-enabled actor whose local time
// matches DigestHour, it enqueues a daily_digest job if one isn't already
// pending/running/done for today.
//
// DigestHour: hour of day in the actor's timezone (0-23). Default 19 (7pm).
type Scheduler struct {
	Store      *store.Store
	Logger     *slog.Logger
	DigestHour int
}

func (s *Scheduler) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	rows, err := s.Store.DB.QueryContext(ctx, `
		SELECT actor_id, timezone FROM actors WHERE digest_enabled = true
	`)
	if err != nil {
		s.Logger.Warn("scheduler list actors", "err", err)
		return
	}
	defer func() { _ = rows.Close() }()
	type a struct{ id, tz string }
	var todo []a
	for rows.Next() {
		var x a
		if err := rows.Scan(&x.id, &x.tz); err != nil {
			continue
		}
		todo = append(todo, x)
	}
	for _, x := range todo {
		loc, err := time.LoadLocation(x.tz)
		if err != nil {
			loc = time.UTC
		}
		now := time.Now().In(loc)
		if now.Hour() != s.DigestHour || now.Minute() != 0 {
			continue
		}
		date := now.Format("2006-01-02")

		// Dedup: skip if a job for (actor, date) already exists today.
		var existing int
		_ = s.Store.DB.QueryRowContext(ctx, `
			SELECT count(*) FROM jobs
			 WHERE kind='daily_digest'
			   AND payload->>'actor_id'=$1
			   AND payload->>'date'=$2
			   AND created_at::date = now()::date
		`, x.id, date).Scan(&existing)
		if existing > 0 {
			continue
		}

		tx, err := s.Store.DB.BeginTx(ctx, nil)
		if err != nil {
			continue
		}
		if err := s.Store.EnqueueJob(ctx, tx, store.KindDailyDigest, map[string]string{
			"actor_id": x.id, "date": date,
		}); err == nil {
			_ = tx.Commit()
			s.Logger.Info("enqueued digest", "actor", x.id, "date", date)
		} else {
			_ = tx.Rollback()
		}
	}
}
