package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

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

// attrMeetingEnded interprets the raw attributes["meeting_ended"] value as a
// "meeting has ended" signal. Clients disagree on the wire type: the Go path
// sends a JSON bool, while auris sends an RFC3339 end-timestamp string. A
// missing key (mid-meeting events) reads as not-ended. A non-bool, non-empty
// string (e.g. a timestamp) counts as ended; "true"/"false"/"1"/"0" are
// honored as their boolean meaning.
func attrMeetingEnded(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return false
		}
		if b, err := strconv.ParseBool(s); err == nil {
			return b
		}
		return true
	default:
		return false
	}
}

// InsertEvent denormalizes meeting_id/meeting_ended from attributes.
func (s *Store) InsertEvent(ctx context.Context, tx *sql.Tx, in EventInput) (EventRecord, error) {
	if len(in.Turns) == 0 {
		return EventRecord{}, errors.New("turns required")
	}
	// Validate that turns is a JSON array, not an object, string, or null.
	// TrimLeft handles valid JSON with leading whitespace (e.g. "  [...]").
	trimmed := bytes.TrimLeft(in.Turns, " \t\n\r")
	if len(trimmed) == 0 || trimmed[0] != '[' {
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
	mended := attrMeetingEnded(attrMap["meeting_ended"])

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
