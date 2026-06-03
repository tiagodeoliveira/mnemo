package store

import "context"

// MeetingRecord is one meeting's finalized categories, assembled for the daily
// digest. Empty fields mean the category had no content. The `highlights`
// category is intentionally not represented — verbatim quotes are noise in a
// digest.
type MeetingRecord struct {
	MeetingID string
	Summary   string
	Decisions string
	Actions   string
	Questions string
	Followups string
}

// ListMeetingsByDate returns the meetings finalized on `date` (a YYYY-MM-DD
// string interpreted in the actor's timezone), each assembled from its
// per-category `meeting` rows, in finalize order.
//
// Correlation is by finalize time (memory created_at) converted to the actor's
// timezone — the same "what was recorded today" model the daily_log digest
// already uses. A meeting that finalizes after the digest runs is not included
// that day.
func (s *Store) ListMeetingsByDate(ctx context.Context, actorID, date string) ([]MeetingRecord, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT split_part(m.namespace,'/',4) AS meeting_id,
		       split_part(m.namespace,'/',5) AS category,
		       m.content
		  FROM memories m JOIN actors a USING(actor_id)
		 WHERE m.actor_id=$1 AND m.dimension='meeting'
		   AND (m.created_at AT TIME ZONE COALESCE(NULLIF(a.timezone, ''), 'UTC'))::date = $2::date
		 ORDER BY m.created_at, meeting_id
	`, actorID, date)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	order := []string{}
	byID := map[string]*MeetingRecord{}
	for rows.Next() {
		var mid, cat, content string
		if err := rows.Scan(&mid, &cat, &content); err != nil {
			return nil, err
		}
		md, ok := byID[mid]
		if !ok {
			md = &MeetingRecord{MeetingID: mid}
			byID[mid] = md
			order = append(order, mid)
		}
		switch cat {
		case "summary":
			md.Summary = content
		case "decisions":
			md.Decisions = content
		case "actions":
			md.Actions = content
		case "questions":
			md.Questions = content
		case "followups":
			md.Followups = content
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]MeetingRecord, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}
