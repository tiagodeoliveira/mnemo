package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestInsertEventRejectsBadTurns(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
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
			defer func() { _ = tx.Rollback() }()
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
	defer func() { _ = s.Close() }()
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
		{"clean array", json.RawMessage(`[{"role":"user","content":"hi"}]`)},
		{"leading spaces", json.RawMessage(`  [{"role":"user","content":"hi"}]`)},
		{"leading newline", json.RawMessage("\n[{\"role\":\"user\"}]")},
		{"leading tab", json.RawMessage("\t[{\"role\":\"user\"}]")},
		{"leading crlf", json.RawMessage("\r\n[{\"role\":\"user\"}]")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx, _ := s.DB.BeginTx(ctx, nil)
			defer func() { _ = tx.Rollback() }()
			_, err := s.InsertEvent(ctx, tx, EventInput{
				ActorID:   "auth0|alice",
				SessionID: "sess-ok-" + tc.name,
				Turns:     tc.turns,
			})
			if err != nil {
				t.Fatalf("unexpected error for %s: %v", tc.name, err)
			}
		})
	}
}

func TestInsertEventDenormalizesMeeting(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
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

// attrMeetingEnded must treat the attribute as "ended" whether the client
// sends a JSON bool (true) or a non-empty timestamp string (auris emits an
// RFC3339 end time). Mid-meeting events omit the key entirely.
func TestAttrMeetingEnded(t *testing.T) {
	cases := []struct {
		name string
		val  any
		want bool
	}{
		{"absent (nil)", nil, false},
		{"bool true", true, true},
		{"bool false", false, false},
		{"rfc3339 string", "2026-05-30T01:43:10Z", true},
		{"string true", "true", true},
		{"string false", "false", false},
		{"string 1", "1", true},
		{"string 0", "0", false},
		{"empty string", "", false},
		{"whitespace string", "   ", false},
		{"unexpected number", float64(1), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := attrMeetingEnded(tc.val); got != tc.want {
				t.Fatalf("attrMeetingEnded(%#v) = %v, want %v", tc.val, got, tc.want)
			}
		})
	}
}
