package store

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestListMeetingsByDate(t *testing.T) {
	dsn := StartTestPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	// Pin Alice to US Eastern so the date math is timezone-sensitive.
	tz := "America/New_York"
	if _, err := s.UpdateActorProfile(ctx, "alice", ActorProfileUpdate{Timezone: &tz}); err != nil {
		t.Fatal(err)
	}

	// insert writes one meeting category row at an explicit UTC timestamp.
	insert := func(meetingID, category, content, ts string) {
		ns := "/meetings/alice/" + meetingID + "/" + category + "/"
		if _, err := s.DB.ExecContext(ctx, `
			INSERT INTO memories (memory_id, actor_id, dimension, namespace, content, created_at)
			VALUES ($1, 'alice', 'meeting', $2, $3, $4::timestamptz)
		`, uuid.New(), ns, content, ts); err != nil {
			t.Fatal(err)
		}
	}

	// m1: 2026-06-02 14:00Z = 10:00 EDT  -> date 2026-06-02
	insert("m1", "summary", "An interview with a backend candidate.", "2026-06-02T14:00:00Z")
	insert("m1", "decisions", "Advance to onsite.", "2026-06-02T14:00:00Z")
	insert("m1", "highlights", `[Speaker 2]: "a verbatim quote"`, "2026-06-02T14:00:00Z")
	// m2: 2026-06-02 23:30Z = 19:30 EDT  -> still date 2026-06-02
	insert("m2", "summary", "A 1:1 about roadmap.", "2026-06-02T23:30:00Z")
	// m3: 2026-06-01 16:00Z = 12:00 EDT  -> date 2026-06-01 (different day)
	insert("m3", "summary", "Yesterday's meeting.", "2026-06-01T16:00:00Z")

	got, err := s.ListMeetingsByDate(ctx, "alice", "2026-06-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 meetings for 2026-06-02, got %d: %+v", len(got), got)
	}
	// Finalize order: m1 (14:00Z) before m2 (23:30Z).
	if got[0].MeetingID != "m1" || got[1].MeetingID != "m2" {
		t.Fatalf("wrong order/ids: %+v", got)
	}
	if got[0].Summary == "" || got[0].Decisions != "Advance to onsite." {
		t.Fatalf("m1 categories not assembled: %+v", got[0])
	}
	// highlights has no field on MeetingRecord, so it can never surface.
	if got[1].Summary != "A 1:1 about roadmap." {
		t.Fatalf("m2 summary wrong: %+v", got[1])
	}
}

// TestListMeetingsByDateEmptyTimezone guards the COALESCE fallback: an actor
// whose timezone column is the empty string (Postgres would reject
// `AT TIME ZONE ''`) must still resolve via UTC instead of failing the digest.
func TestListMeetingsByDateEmptyTimezone(t *testing.T) {
	dsn := StartTestPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "bob"); err != nil {
		t.Fatal(err)
	}
	// Force an empty-string timezone directly (the API normally prevents this).
	if _, err := s.DB.ExecContext(ctx, `UPDATE actors SET timezone='' WHERE actor_id='bob'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.ExecContext(ctx, `
		INSERT INTO memories (memory_id, actor_id, dimension, namespace, content, created_at)
		VALUES ($1, 'bob', 'meeting', '/meetings/bob/mtg/summary/', 'A standup.', '2026-06-02T09:00:00Z'::timestamptz)
	`, uuid.New()); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListMeetingsByDate(ctx, "bob", "2026-06-02")
	if err != nil {
		t.Fatalf("empty timezone should fall back to UTC, not error: %v", err)
	}
	if len(got) != 1 || got[0].Summary != "A standup." {
		t.Fatalf("want the UTC-dated meeting, got %+v", got)
	}
}
