package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestInsertEventDenormalizesMeeting(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "auth0|alice"); err != nil {
		t.Fatal(err)
	}

	tx, _ := s.DB.BeginTx(ctx, nil)
	rec, err := s.InsertEvent(ctx, tx, EventInput{
		ActorID:    "auth0|alice",
		SessionID:  "sess-1",
		Turns:      json.RawMessage(`[{"role":"user","content":"hi"}]`),
		Attributes: json.RawMessage(`{"meeting_id":"design","meeting_ended":true}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()

	if !rec.MeetingID.Valid || rec.MeetingID.String != "design" || !rec.MeetingEnded {
		t.Fatalf("denormalize: %+v", rec)
	}
}
