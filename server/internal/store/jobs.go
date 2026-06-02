package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type JobKind string

const (
	KindExtractContext       JobKind = "extract_context"
	KindFinalizeMeeting      JobKind = "finalize_meeting"
	KindDailyDigest          JobKind = "daily_digest"
	KindBackfillEmbeddings   JobKind = "backfill_embeddings"
)

type Job struct {
	JobID    int64
	Kind     JobKind
	Payload  json.RawMessage
	Attempts int
}

// ReclaimStaleJobs resets any `state='running'` rows to `state='pending'`.
// Call this at server boot, BEFORE the worker pool starts claiming jobs.
//
// Invariant: when main() reaches the worker-pool setup, no worker can
// possibly hold a lock yet. Therefore any row in 'running' is by definition
// stale (the previous process crashed mid-job and never called FailJob).
// Resetting them to 'pending' lets the new worker pool re-claim them.
//
// Returns the number of rows reclaimed (informational).
func (s *Store) ReclaimStaleJobs(ctx context.Context) (int64, error) {
	res, err := s.DB.ExecContext(ctx, `
		UPDATE jobs
		   SET state = 'pending', locked_by = NULL, locked_at = NULL
		 WHERE state = 'running'
	`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// EnqueueJob inserts a pending job. Must be called inside a tx.
func (s *Store) EnqueueJob(ctx context.Context, tx *sql.Tx, kind JobKind, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO jobs (kind, payload) VALUES ($1, $2)
	`, string(kind), b)
	return err
}

// ClaimJob atomically picks one pending job, marks it running. Returns (nil,nil) on empty queue.
func (s *Store) ClaimJob(ctx context.Context, workerID string) (*Job, error) {
	row := s.DB.QueryRowContext(ctx, `
		UPDATE jobs
		   SET state = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
		 WHERE job_id = (
		     SELECT job_id FROM jobs
		      WHERE state = 'pending' AND run_after <= now()
		      ORDER BY job_id
		      FOR UPDATE SKIP LOCKED LIMIT 1
		 )
		 RETURNING job_id, kind, payload, attempts
	`, workerID)

	var j Job
	if err := row.Scan(&j.JobID, &j.Kind, &j.Payload, &j.Attempts); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &j, nil
}

func (s *Store) CompleteJob(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs SET state='done', completed_at=now(), last_error=NULL WHERE job_id=$1
	`, id)
	return err
}

// ReleaseStaleLocks resets state='running' rows whose locked_at is older
// than threshold back to state='pending', preserving attempts so retries
// continue at the same count.
//
// Distinct from ReclaimStaleJobs (boot-time, no threshold) — this is the
// continuous reaper that catches mid-flight worker crashes while OTHER
// instances are still running.
func (s *Store) ReleaseStaleLocks(ctx context.Context, threshold time.Duration) (int64, error) {
	thresholdSecs := int(threshold.Seconds())
	res, err := s.DB.ExecContext(ctx, `
		UPDATE jobs
		   SET state = 'pending', locked_by = NULL, locked_at = NULL
		 WHERE state = 'running'
		   AND locked_at < now() - make_interval(secs => $1)
	`, thresholdSecs)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// RescheduleJob puts a claimed job back to pending with a delay, refunding
// the attempt that ClaimJob debited. Use it when the worker decided not to
// run the job for *systemic* reasons (e.g. the kind's circuit breaker is
// open) — the job hasn't actually failed, so it shouldn't burn a retry.
//
// `runAfterSec` is the soonest the job becomes eligible again. The reason
// is recorded in last_error for observability.
func (s *Store) RescheduleJob(ctx context.Context, id int64, runAfterSec int, reason string) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs
		   SET state='pending',
		       attempts = GREATEST(attempts - 1, 0),
		       last_error=$2,
		       run_after = now() + make_interval(secs => $3),
		       locked_by=NULL, locked_at=NULL
		 WHERE job_id=$1
	`, id, reason, runAfterSec)
	return err
}

// FailJob marks pending again with backoff, or 'failed' after maxAttempts.
func (s *Store) FailJob(ctx context.Context, id int64, attempts int, errMsg string, runAfterSec int, maxAttempts int) error {
	if attempts >= maxAttempts {
		_, err := s.DB.ExecContext(ctx, `
			UPDATE jobs SET state='failed', last_error=$2, locked_by=NULL, locked_at=NULL WHERE job_id=$1
		`, id, errMsg)
		return err
	}
	// make_interval(secs => $3) accepts an int directly, avoiding the
	// int → text → interval coercion that pgx can't encode through.
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs
		   SET state='pending', last_error=$2,
		       run_after = now() + make_interval(secs => $3),
		       locked_by=NULL, locked_at=NULL
		 WHERE job_id=$1
	`, id, errMsg, runAfterSec)
	return err
}
