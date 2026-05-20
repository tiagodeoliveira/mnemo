package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestInsertEventRejectsBadTurns(t *testing.T) {
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

	cases := []struct {
		name  string
		turns json.RawMessage
	}{
		{"json object", json.RawMessage(`{"role":"user","content":"hi"}`)},
		{"json string", json.RawMessage(`"hello"`)},
		{"json null", json.RawMessage(`null`)},
		{"json number", json.RawMessage(`42`)},
		{"json bool", json.RawMessage(`true`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx, _ := s.DB.BeginTx(ctx, nil)
			defer tx.Rollback()
			_, err := s.InsertEvent(ctx, tx, EventInput{
				ActorID:   "auth0|alice",
				SessionID: "sess-bad",
				Turns:     tc.turns,
			})
			if err == nil {
				t.Fatal("expected error for non-array turns")
			}
			if err != ErrBadTurns {
				t.Errorf("expected ErrBadTurns, got: %v", err)
			}
		})
	}
}

func TestInsertEventAcceptsValidArray(t *testing.T) {
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
	_, err := s.InsertEvent(ctx, tx, EventInput{
		ActorID:   "auth0|alice",
		SessionID: "sess-ok",
		Turns:     json.RawMessage(`[{"role":"user","content":"hi"}]`),
	})
	if err != nil {
		t.Fatalf("unexpected error for valid turns: %v", err)
	}
	_ = tx.Commit()
}

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
