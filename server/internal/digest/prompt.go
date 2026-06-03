package digest

import (
	"fmt"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// SystemDailyDigest builds the daily reflection from two sources: per-day
// activity log entries and that day's finalized meeting summaries.
//
// Three %s injections: date, logsBlock, meetingsBlock.
// Caller: fmt.Sprintf(SystemDailyDigest, date, logsBlock, meetingsBlock)
const SystemDailyDigest = `You are generating a structured daily digest for %s from two sources: activity log entries captured throughout the day, and summaries of meetings that were recorded and finalized that day.

Write for a busy reader skimming in 15 seconds. In every section: at most ONE short sentence of narrative lead, then bullets for the specifics. Hard limits — keep each bullet under 20 words, at most 5 bullets per project, at most 6 bullets in any other section. Prefer cutting a marginal point over completeness; a shorter digest is a better digest. No multi-clause run-on bullets. Lead each bullet with the concrete thing (project, decision, file, person).

Produce these sections:

## Projects
What was worked on, grouped by project. Bold the project name, one-sentence lead, then bullets for specific changes and progress.

## Meetings
One entry per meeting. Lead each with a short label of what it was (e.g. "Interview — backend candidate", "1:1", "design review") inferred from that meeting's own summary — NEVER print a raw meeting id. Then a one-line description and sub-bullets for that meeting's key decisions, action items, and follow-ups. Omit this section entirely if there were no meetings.

## Decisions
Important decisions made today and their rationale; skip trivial ones. If — and only if — a decision was actually stated in one of the meetings below (in the MEETINGS section), add it here tagged "(from meeting)". Decisions from your own logged engineering work are NOT meeting decisions; never tag those. If the meetings contain no decisions, none here should carry the tag.

## Learnings
New things discovered, insights, technical knowledge gained.

## Time Allocation
Rough estimate of where effort went, in relative terms (most of the day, a couple hours, briefly). Include meeting time.

## Blockers & Resolutions
Problems encountered and how they were resolved. Skip if none.

## Carry Forward
Open questions, unfinished work, things to pick up next. If a meeting below produced action items, follow-ups, or unresolved questions, add those here tagged "(from meeting)" — but only items that genuinely came from a meeting. Your own logged TODOs are not meeting items; leave them untagged.

## Reflection
1-2 sentences on what went well and what could improve.

Rules:
- Write your own work in first person. Meetings are third-party (speakers were anonymous) — describe them neutrally, never in first person.
- Be specific — name projects, tools, files, technologies, and meeting labels.
- Skip any section with no content EXCEPT Projects and Reflection, which are always required. Omit Meetings when there were no meetings.
- The "(from meeting)" tag is reserved exclusively for items sourced from the MEETINGS section. When in doubt about an item's origin, do NOT tag it.
- If both sources are sparse, still produce Projects and Reflection with what you have.

LOG ENTRIES:
%s

MEETINGS:
%s`

// BuildLogsBlock formats log entries the way the TS does.
func BuildLogsBlock(entries []string) string {
	var b strings.Builder
	for i, e := range entries {
		if i > 0 {
			b.WriteString("\n\n")
		}
		fmt.Fprintf(&b, "Entry %d:\n%s", i+1, e)
	}
	return b.String()
}

// BuildMeetingsBlock renders the day's meetings into the block injected as the
// third %s of SystemDailyDigest. Each meeting is a numbered block carrying its
// non-empty categories under uppercase labels, mirroring BuildLogsBlock. The
// raw meeting id is never emitted — the prompt derives a human label from the
// summary. Returns "" when there is nothing to show.
func BuildMeetingsBlock(meetings []store.MeetingRecord) string {
	var b strings.Builder
	n := 0
	for _, m := range meetings {
		labelled := []struct{ label, body string }{
			{"SUMMARY", m.Summary},
			{"DECISIONS", m.Decisions},
			{"ACTIONS", m.Actions},
			{"QUESTIONS", m.Questions},
			{"FOLLOWUPS", m.Followups},
		}
		var body strings.Builder
		for _, p := range labelled {
			if strings.TrimSpace(p.body) == "" {
				continue
			}
			fmt.Fprintf(&body, "%s:\n%s\n", p.label, strings.TrimSpace(p.body))
		}
		if body.Len() == 0 {
			continue
		}
		n++
		if n > 1 {
			b.WriteString("\n\n")
		}
		fmt.Fprintf(&b, "Meeting %d:\n%s", n, strings.TrimSpace(body.String()))
	}
	return b.String()
}

// DigestTruncatedError signals max_tokens during digest generation.
type DigestTruncatedError struct {
	Date string
}

func (e *DigestTruncatedError) Error() string {
	return fmt.Sprintf("digest generation for %s hit max_tokens — refusing to write truncated summary", e.Date)
}
