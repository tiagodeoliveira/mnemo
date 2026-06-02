package queue

import (
	"context"
	"database/sql"
	"log/slog"
	"time"
)

// Stable advisory-lock keys. These are arbitrary int64 constants; pick
// values that won't collide with any other system that might use advisory
// locks on this Postgres instance (none today, but reserve a high range).
const (
	LockKeyDigestScheduler   int64 = 0x6D6E_656D_6F00_0001 // 'mnemo' + scheduler ids
	LockKeyBackfillScheduler int64 = 0x6D6E_656D_6F00_0002
	LockKeySweeper           int64 = 0x6D6E_656D_6F00_0003
	LockKeyReaper            int64 = 0x6D6E_656D_6F00_0004
	LockKeyMemoryExpiry      int64 = 0x6D6E_656D_6F00_0005
)

// RunAsLeader executes fn when this instance acquires the advisory lock
// identified by lockKey. Polls every retryInterval if not currently leader.
// fn should respect ctx cancellation; this helper returns when ctx is done.
//
// The advisory lock is session-scoped (released when the dedicated connection
// closes), so if this instance crashes Postgres releases the lock and another
// instance can acquire it on its next poll.
func RunAsLeader(
	ctx context.Context,
	db *sql.DB,
	logger *slog.Logger,
	role string,
	lockKey int64,
	retryInterval time.Duration,
	fn func(ctx context.Context),
) {
	if retryInterval <= 0 {
		retryInterval = 30 * time.Second
	}
	for {
		if ctx.Err() != nil {
			return
		}
		// Acquire a dedicated connection from the pool. Holding it keeps
		// the advisory lock alive; releasing it (via .Close()) releases
		// the lock.
		conn, err := db.Conn(ctx)
		if err != nil {
			logger.Warn("leader: failed to acquire dedicated connection", "role", role, "err", err)
			sleepCtx(ctx, retryInterval)
			continue
		}
		var got bool
		row := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, lockKey)
		if err := row.Scan(&got); err != nil {
			logger.Warn("leader: pg_try_advisory_lock query failed", "role", role, "err", err)
			_ = conn.Close()
			sleepCtx(ctx, retryInterval)
			continue
		}
		if !got {
			// Another instance holds the lock. Release our connection
			// and retry.
			_ = conn.Close()
			sleepCtx(ctx, retryInterval)
			continue
		}

		logger.Info("leader: acquired role", "role", role)
		fn(ctx)
		// fn returned (likely ctx cancellation). Release the lock by
		// explicitly unlocking, then return the connection. The unlock
		// is best-effort — connection close also releases.
		_, _ = conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock($1)`, lockKey)
		_ = conn.Close()
		logger.Info("leader: released role", "role", role)
		return
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
