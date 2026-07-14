package store

import "context"

// MeetingRecord is one meeting's finalized memory, assembled for the daily
// digest. A meeting is now a single narrative summary; Summary holds it.
type MeetingRecord struct {
	MeetingID string
	Summary   string
}

// ListMeetingsByDate returns the meetings finalized on `date` (a YYYY-MM-DD
// string interpreted in the actor's timezone), each represented by its single
// `summary` memory row, in finalize order.
//
// Correlation is by finalize time (memory created_at) converted to the actor's
// timezone — the same "what was recorded today" model the daily_log digest
// already uses. A meeting that finalizes after the digest runs is not included
// that day.
func (s *Store) ListMeetingsByDate(ctx context.Context, actorID, date string) ([]MeetingRecord, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT split_part(m.namespace,'/',4) AS meeting_id,
		       m.content
		  FROM memories m JOIN actors a USING(actor_id)
		 WHERE m.actor_id=$1 AND m.dimension='meeting'
		   AND split_part(m.namespace,'/',5) = 'summary'
		   AND (m.created_at AT TIME ZONE COALESCE(NULLIF(a.timezone, ''), 'UTC'))::date = $2::date
		 ORDER BY m.created_at, meeting_id
	`, actorID, date)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := []MeetingRecord{}
	for rows.Next() {
		var mid, content string
		if err := rows.Scan(&mid, &content); err != nil {
			return nil, err
		}
		out = append(out, MeetingRecord{MeetingID: mid, Summary: content})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
