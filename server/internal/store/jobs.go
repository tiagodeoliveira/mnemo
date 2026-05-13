package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type JobKind string

const (
	KindExtractContext  JobKind = "extract_context"
	KindFinalizeMeeting JobKind = "finalize_meeting"
	KindDailyDigest     JobKind = "daily_digest"
)

type Job struct {
	JobID    int64
	Kind     JobKind
	Payload  json.RawMessage
	Attempts int
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

// FailJob marks pending again with backoff, or 'failed' after maxAttempts.
func (s *Store) FailJob(ctx context.Context, id int64, attempts int, errMsg string, runAfterSec int, maxAttempts int) error {
	if attempts >= maxAttempts {
		_, err := s.DB.ExecContext(ctx, `
			UPDATE jobs SET state='failed', last_error=$2, locked_by=NULL, locked_at=NULL WHERE job_id=$1
		`, id, errMsg)
		return err
	}
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs
		   SET state='pending', last_error=$2,
		       run_after = now() + ($3 || ' seconds')::interval,
		       locked_by=NULL, locked_at=NULL
		 WHERE job_id=$1
	`, id, errMsg, runAfterSec)
	return err
}
