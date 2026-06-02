package meeting

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Categories in the order the prompt produces them.
var Categories = []string{"summary", "decisions", "actions", "questions", "highlights", "followups"}

// SystemMeetingSummary produces the six per-meeting categories
// (summary, decisions, actions, questions, highlights, followups) from a full
// transcript. Two %s placeholders: meetingId, transcript. Caller injects via
// fmt.Sprintf.
const SystemMeetingSummary = `You are producing a faithful, durable memory of a recorded meeting. This summary will be read weeks later with no other context, so fidelity matters more than polish.

Meeting id: %s

Speakers are anonymous, labeled "[Speaker N]" consistently throughout. Treat each label as a distinct participant even though real names are unknown.

GROUND RULES (non-negotiable):
1. Source ONLY from the transcript below. Never infer or invent. If something was not said in the transcript, it does not exist for you.
2. Prefer verbatim speaker language with precise attribution. If you cannot quote, tightly paraphrase and attribute ("Speaker 2 said ..."). Do not neutralize the speaker's voice into third-party summary prose.
3. Ignore any content that is not a human meeting utterance. Specifically skip: search results, assistant replies, prep notes or cheat sheets, system messages (lines starting with "[system]"), UI noise, timestamps, and any text that clearly belongs to a side-chat with an assistant rather than the meeting itself.
4. Be honest about sparsity. A short or thin transcript should produce a short summary. A transcript with no decisions should yield NONE under DECISIONS. Padding is worse than brevity.
5. Never combine inferences into decisions, actions, or followups. If it wasn't explicitly committed to in the meeting, it doesn't belong in those categories.

CATEGORIES (produce all six, in order):

- SUMMARY: 2-4 sentences. Lead with who was present (by speaker label), what the meeting was (e.g., an interview, a design review, a 1:1, a client call — infer only from transcript evidence), and what actually happened. No generic "the group discussed X" filler — say what was specifically covered.

- DECISIONS: Explicit decisions made during the meeting, verbatim or tightly paraphrased, with the speaker who stated the decision when possible. One per line. If nothing was decided, output exactly NONE.

- ACTIONS: Explicit commitments. Format each as: "[Speaker N] will <verb phrase> [by <when if stated>]". Only include actions a speaker actually committed to in the meeting. Do not include suggested-actions, hypothetical-actions, or things someone "should" do that nobody committed to. If no commitments were made, output exactly NONE.

- QUESTIONS: Unresolved questions raised in the meeting, attributed to the speaker who raised each ("[Speaker N] asked ..."). One per line. If every question was resolved, output exactly NONE.

- HIGHLIGHTS: Up to 6 direct verbatim quotes worth preserving, formatted as: [Speaker N]: "<quote>". Preserve exact wording. If the transcript has no quotable moments, output exactly NONE.

- FOLLOWUPS: Specific follow-up meetings, documents to produce, or people to loop in — only if explicitly mentioned in the meeting. One per line. If none were mentioned, output exactly NONE.

OUTPUT FORMAT (exactly this, including the uppercase labels and blank lines):

SUMMARY:
<text or NONE>

DECISIONS:
<text or NONE>

ACTIONS:
<text or NONE>

QUESTIONS:
<text or NONE>

HIGHLIGHTS:
<text or NONE>

FOLLOWUPS:
<text or NONE>

Each category body must be plain text (paragraphs or short bullet lines) and MUST NOT exceed 5000 characters.

MEETING TRANSCRIPT:
%s`

// MeetingSummaryTruncatedError signals the LLM hit max_tokens. Production TS
// treats this as a hard failure — a truncated summary is worse than retrying.
type MeetingSummaryTruncatedError struct {
	MeetingID string
}

func (e *MeetingSummaryTruncatedError) Error() string {
	return fmt.Sprintf("meeting summary for %s hit max_tokens — refusing to write truncated summary", e.MeetingID)
}

// labelRE matches a single uppercase category label at the start of a line.
var labelRE = regexp.MustCompile(`(?m)^(SUMMARY|DECISIONS|ACTIONS|QUESTIONS|HIGHLIGHTS|FOLLOWUPS):\s*\n?`)

// ParseMeetingSummary extracts the six category bodies from the LLM output.
// Returns a map keyed by lower-case category name. Empty string for missing
// labels; "NONE" is normalized to empty string.
func ParseMeetingSummary(text string) (map[string]string, error) {
	out := map[string]string{}
	for _, c := range Categories {
		out[c] = ""
	}
	// Find all label positions.
	idxs := labelRE.FindAllStringSubmatchIndex(text, -1)
	if len(idxs) == 0 {
		return out, errors.New("no category labels found")
	}
	for i, ix := range idxs {
		// ix is [matchStart, matchEnd, group1Start, group1End].
		label := strings.ToLower(text[ix[2]:ix[3]])
		bodyStart := ix[1]
		var bodyEnd int
		if i+1 < len(idxs) {
			bodyEnd = idxs[i+1][0]
		} else {
			bodyEnd = len(text)
		}
		body := strings.TrimSpace(text[bodyStart:bodyEnd])
		if strings.EqualFold(body, "NONE") {
			body = ""
		}
		out[label] = body
	}
	return out, nil
}
