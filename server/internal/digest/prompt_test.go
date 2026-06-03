package digest

import (
	"strings"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func TestBuildMeetingsBlock(t *testing.T) {
	meetings := []store.MeetingRecord{
		{
			MeetingID: "m1",
			Summary:   "An interview with a backend candidate.",
			Decisions: "Advance to onsite.",
			// Actions/Questions empty -> omitted.
			Followups: "Send take-home by Friday.",
		},
		{
			MeetingID: "m2",
			Summary:   "A 1:1 about roadmap.",
		},
	}
	block := BuildMeetingsBlock(meetings)

	if !strings.Contains(block, "Meeting 1:") || !strings.Contains(block, "Meeting 2:") {
		t.Fatalf("missing numbered meeting headers:\n%s", block)
	}
	if !strings.Contains(block, "SUMMARY:") || !strings.Contains(block, "DECISIONS:") || !strings.Contains(block, "FOLLOWUPS:") {
		t.Fatalf("missing category labels:\n%s", block)
	}
	if strings.Contains(block, "ACTIONS:") || strings.Contains(block, "QUESTIONS:") {
		t.Fatalf("empty categories should be omitted:\n%s", block)
	}
	if strings.Contains(block, "m1") || strings.Contains(block, "m2") {
		t.Fatalf("raw meeting ids must not leak into the block:\n%s", block)
	}
	if BuildMeetingsBlock(nil) != "" {
		t.Fatal("empty input should produce empty block")
	}
}
