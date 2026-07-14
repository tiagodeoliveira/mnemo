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
			Summary:   "An interview with a backend candidate. Agreed to advance to onsite.",
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
	if !strings.Contains(block, "advance to onsite") || !strings.Contains(block, "1:1 about roadmap") {
		t.Fatalf("summary narrative missing from block:\n%s", block)
	}
	// No category-label scaffolding anymore — the memory is a single narrative.
	if strings.Contains(block, "SUMMARY:") || strings.Contains(block, "DECISIONS:") ||
		strings.Contains(block, "ACTIONS:") || strings.Contains(block, "QUESTIONS:") ||
		strings.Contains(block, "FOLLOWUPS:") {
		t.Fatalf("category labels must no longer appear:\n%s", block)
	}
	// A meeting whose summary is empty is skipped entirely.
	if strings.Contains(BuildMeetingsBlock([]store.MeetingRecord{{MeetingID: "x"}}), "Meeting 1:") {
		t.Fatal("a summary-less meeting should be omitted")
	}
	if strings.Contains(block, "m1") || strings.Contains(block, "m2") {
		t.Fatalf("raw meeting ids must not leak into the block:\n%s", block)
	}
	if BuildMeetingsBlock(nil) != "" {
		t.Fatal("empty input should produce empty block")
	}
}
