package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
)

type EventInput struct {
	ActorID     string
	SessionID   string
	Project     string // "" allowed
	Source      string
	Workstation string
	Workdir     string
	Turns       json.RawMessage // pre-validated JSON array
	Attributes  json.RawMessage // pre-validated JSON object; nil ⇒ "{}"
}

type EventRecord struct {
	EventID      uuid.UUID
	MeetingID    sql.NullString
	MeetingEnded bool
}

// ErrBadTurns is returned when the turns field is not a JSON array.
var ErrBadTurns = errors.New("turns must be a JSON array")

// InsertEvent denormalizes meeting_id/meeting_ended from attributes.
func (s *Store) InsertEvent(ctx context.Context, tx *sql.Tx, in EventInput) (EventRecord, error) {
	if len(in.Turns) == 0 {
		return EventRecord{}, errors.New("turns required")
	}
	// Validate that turns is a JSON array, not an object, string, or null.
	if in.Turns[0] != '[' {
		return EventRecord{}, ErrBadTurns
	}
	attrs := in.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}

	var attrMap map[string]any
	if err := json.Unmarshal(attrs, &attrMap); err != nil {
		return EventRecord{}, errors.New("attributes not a JSON object")
	}
	mid, _ := attrMap["meeting_id"].(string)
	mended, _ := attrMap["meeting_ended"].(bool)

	id := uuid.New()
	_, err := tx.ExecContext(ctx, `
		INSERT INTO events (event_id, actor_id, session_id, project, source,
		                    workstation, workdir, turns, attributes, meeting_id, meeting_ended)
		VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8,$9,
		        NULLIF($10,''), $11)
	`, id, in.ActorID, in.SessionID, in.Project, in.Source, in.Workstation, in.Workdir,
		in.Turns, attrs, mid, mended)
	if err != nil {
		return EventRecord{}, err
	}

	rec := EventRecord{EventID: id, MeetingEnded: mended}
	if mid != "" {
		rec.MeetingID = sql.NullString{String: mid, Valid: true}
	}
	return rec, nil
}
