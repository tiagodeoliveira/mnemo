package digest

import "fmt"

// SystemDailyDigest is the verbatim production prompt ported from
// infra/lambda/daily-digest/index.ts lines 104-139.
//
// Two %s injections: date, logsBlock.
// Caller: fmt.Sprintf(SystemDailyDigest, date, logsBlock)
// where logsBlock is the concatenated "Entry N:\n<content>" blocks.
const SystemDailyDigest = `You are generating a structured daily digest for %s from activity log entries captured throughout the day.

Produce a reflection with these sections:

## Projects
What was worked on, organized by project. Brief description of progress and key changes for each.

## Decisions
Important decisions made and their rationale. Skip trivial choices.

## Learnings
New things discovered, insights, technical knowledge gained.

## Time Allocation
Rough estimate of where effort went (by project or activity type). Use relative terms (most of the day, a couple hours, briefly).

## Blockers & Resolutions
Problems encountered and how they were resolved. Skip if none.

## Carry Forward
Open questions, unfinished work, or things to pick up next.

## Reflection
1-2 sentences on what went well and what could improve.

Rules:
- Write in first person
- Be specific — name projects, tools, files, and technologies
- Skip sections that have no content for the day (except Projects and Reflection, which are always required)
- If the log entries are too sparse for a meaningful digest, still produce Projects and Reflection with what you have

LOG ENTRIES:
%s`

// BuildLogsBlock formats log entries the way the TS does.
func BuildLogsBlock(entries []string) string {
	out := ""
	for i, e := range entries {
		if i > 0 {
			out += "\n\n"
		}
		out += fmt.Sprintf("Entry %d:\n%s", i+1, e)
	}
	return out
}

// DigestTruncatedError signals max_tokens during digest generation.
type DigestTruncatedError struct {
	Date string
}

func (e *DigestTruncatedError) Error() string {
	return fmt.Sprintf("digest generation for %s hit max_tokens — refusing to write truncated summary", e.Date)
}
