package meeting

import (
	"errors"
	"fmt"
	"strings"
)

// SystemMeetingSummary produces a single, complete narrative memory of a
// recorded meeting from its full transcript. Two %s placeholders: meetingId,
// transcript. Caller injects via fmt.Sprintf.
//
// The output is ONE free-form summary (no category scaffolding). It is stored
// verbatim as the meeting's durable memory, so the prompt optimises for
// faithful completeness over structure: someone reading it weeks later, with no
// other context, should understand what the meeting was, who was there, the
// substance that was covered, and anything left open.
const SystemMeetingSummary = `You are writing the single durable memory of a recorded meeting. It will be read weeks later with no other context and no access to the transcript, so completeness and fidelity matter far more than brevity or polish.

Meeting id: %s

Speakers are anonymous, labeled "[Speaker N]" consistently throughout. Treat each label as a distinct participant even though real names are unknown.

GROUND RULES (non-negotiable):
1. Source ONLY from the transcript below. Never infer, guess, or invent. If something was not said in the transcript, it does not exist for you.
2. Preserve concrete specifics. Keep the details that make this meeting worth remembering: participants and their stated backgrounds, numbers and figures (money, headcount, percentages, dates, timelines), product / strategy / technical specifics, named entities (companies, teams, products, SKUs, tools), organizational structure, and any decisions made or in progress. Vague generalities ("they discussed the product") are a failure — say what was specifically covered.
3. Scale length to substance. A thin or short meeting gets a short memory (a few sentences). A rich, substantive meeting gets a thorough one — several detailed paragraphs. Never pad a thin meeting; never compress a rich one into a generic blurb.
4. Attribute clearly. Prefer "[Speaker N] explained/asked/committed to ..." over faceless third-party prose. Quote a pivotal line verbatim when its exact wording carries meaning, using [Speaker N]: "...". Do not neutralize the speakers' voices into anonymous summary.
5. Capture what was left open. If the meeting ended with genuinely unresolved questions, open threads, or things explicitly deferred, include them (a short closing paragraph or a few lines is fine) — but ONLY if they were actually left unresolved in the transcript. Do not manufacture open items.
6. Ignore anything that is not a human meeting utterance: assistant replies, search results, prep notes or cheat sheets, system messages (lines starting with "[system]"), UI noise, and any side-chat with an assistant rather than the meeting itself.

OUTPUT:
Write the memory as plain narrative prose (paragraphs, and short attributed lines or quotes where useful). Do NOT emit section headers, category labels, bullets scaffolding, JSON, or any preamble like "Summary:" — just the memory itself. Keep it under 6000 characters.

MEETING TRANSCRIPT:
%s`

// MeetingSummaryTruncatedError signals the LLM hit max_tokens. A truncated
// summary is worse than retrying, so the caller treats this as a hard failure.
type MeetingSummaryTruncatedError struct {
	MeetingID string
}

func (e *MeetingSummaryTruncatedError) Error() string {
	return fmt.Sprintf("meeting summary for %s hit max_tokens — refusing to write truncated summary", e.MeetingID)
}

// ParseMeetingSummary normalizes the LLM output into the single summary body we
// persist. The whole output IS the memory: we trim surrounding whitespace and
// strip an accidental leading "Summary:" label if the model adds one despite the
// instructions. An empty result is an error — an empty memory is never written.
func ParseMeetingSummary(text string) (string, error) {
	body := strings.TrimSpace(text)
	// Defensive: tolerate a stray leading label even though the prompt forbids it.
	if rest, ok := strings.CutPrefix(body, "SUMMARY:"); ok {
		body = strings.TrimSpace(rest)
	} else if rest, ok := strings.CutPrefix(body, "Summary:"); ok {
		body = strings.TrimSpace(rest)
	}
	if body == "" {
		return "", errors.New("meeting summary was empty")
	}
	return body, nil
}
