package extract

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// ProjectTaskLog holds the structured output of the classifier prompt.
// Project- and task-shaped facts are split so the same content isn't written
// to two namespaces.
type ProjectTaskLog struct {
	TaskDomain   string // sanitized lower-snake-case; "unknown" if missing, "general" if outside allowed list
	ProjectFacts string // multi-line text; "" if NONE or absent
	TaskFacts    string // multi-line text; "" if NONE or absent
	Daily        string // multi-line text; "" if NONE or absent
}

// AllowedDomains is the canonical task-domain list. Mirrors getTaskDomains() in the TS.
var AllowedDomains = []string{"coding", "studying", "meeting", "general"}

var taskRE = regexp.MustCompile(`(?im)^TASK:\s*(.+)$`)
var projectFactsRE = regexp.MustCompile(`(?im)^PROJECT_FACTS:\s*\n([\s\S]*?)\nTASK_FACTS:`)
var taskFactsRE = regexp.MustCompile(`(?im)^TASK_FACTS:\s*\n([\s\S]*?)\nDAILY:`)
// Legacy single-bucket FACTS layout (pre-split) — supported for backward
// compatibility when an older prompt response sneaks through.
var legacyFactsRE = regexp.MustCompile(`(?im)^FACTS:\s*\n([\s\S]*?)\nDAILY:`)
var dailyRE = regexp.MustCompile(`(?im)^DAILY:\s*\n?([\s\S]*)$`)

// ParseProjectTaskLog parses the custom format from the classifier prompt.
// Returns the zero-value struct + an error if the TASK line is missing.
// "NONE" or empty body in any facts/daily block is normalized to "".
func ParseProjectTaskLog(text string) (ProjectTaskLog, error) {
	out := ProjectTaskLog{TaskDomain: "unknown"}
	tm := taskRE.FindStringSubmatch(text)
	if len(tm) < 2 {
		return out, errors.New("parse: no TASK line found")
	}
	out.TaskDomain = sanitizeDomain(strings.TrimSpace(tm[1]))

	if fm := projectFactsRE.FindStringSubmatch(text); len(fm) >= 2 {
		if s := strings.TrimSpace(fm[1]); !isNone(s) {
			out.ProjectFacts = s
		}
	}
	if fm := taskFactsRE.FindStringSubmatch(text); len(fm) >= 2 {
		if s := strings.TrimSpace(fm[1]); !isNone(s) {
			out.TaskFacts = s
		}
	}
	// If the model emitted legacy FACTS:, fall back to task-bucket so we don't
	// silently drop content from older responses still in flight.
	if out.ProjectFacts == "" && out.TaskFacts == "" {
		if fm := legacyFactsRE.FindStringSubmatch(text); len(fm) >= 2 {
			if s := strings.TrimSpace(fm[1]); !isNone(s) {
				out.TaskFacts = s
			}
		}
	}
	if dm := dailyRE.FindStringSubmatch(text); len(dm) >= 2 {
		if s := strings.TrimSpace(dm[1]); !isNone(s) {
			out.Daily = s
		}
	}
	return out, nil
}

func sanitizeDomain(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" || s == "unknown" {
		return "unknown"
	}
	for _, d := range AllowedDomains {
		if d == s {
			return s
		}
	}
	return "general"
}

func isNone(s string) bool {
	return s == "" || strings.EqualFold(s, "NONE")
}

// PreferencesOutput is the JSON shape from SystemExtractPreferences.
type PreferencesOutput struct {
	Preferences []string `json:"preferences"`
}

// EpisodesOutput is the JSON shape from SystemExtractEpisodes.
type EpisodesOutput struct {
	Episodes []struct {
		Event      string `json:"event"`
		Reflection string `json:"reflection"`
	} `json:"episodes"`
}

// strictUnmarshal trims common pre/postambles (```json ... ```), then decodes.
func strictUnmarshal(s string, into any) error {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)
	if s == "" {
		return errors.New("empty llm output")
	}
	return json.Unmarshal([]byte(s), into)
}

func ParsePreferences(s string) (PreferencesOutput, error) {
	var out PreferencesOutput
	return out, strictUnmarshal(s, &out)
}

func ParseEpisodes(s string) (EpisodesOutput, error) {
	var out EpisodesOutput
	return out, strictUnmarshal(s, &out)
}

// aboutRE matches the ABOUT: header and captures everything below it.
var aboutRE = regexp.MustCompile(`(?im)^ABOUT:\s*\n?([\s\S]*)$`)

// ParseAbout parses the ABOUT: block output from SystemExtractAbout into a
// slice of NewItem values (one per non-empty, non-NONE line).
func ParseAbout(s string) []NewItem {
	m := aboutRE.FindStringSubmatch(s)
	if len(m) < 2 {
		return nil
	}
	body := strings.TrimSpace(m[1])
	if isNone(body) {
		return nil
	}
	var out []NewItem
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || isNone(line) {
			continue
		}
		out = append(out, NewItem{Content: line, Tags: []string{"identity"}})
	}
	return out
}

// rawUpdateOp is the intermediate JSON representation for an update op before UUID parsing.
type rawUpdateOp struct {
	ID      string   `json:"id"`
	Content string   `json:"content"`
	Tags    []string `json:"tags"`
}

// rawDiff is the intermediate JSON representation before UUID parsing.
type rawDiffFull struct {
	Keep      []string      `json:"keep"`
	Reinforce []string      `json:"reinforce"`
	Delete    []string      `json:"delete"`
	Update    []rawUpdateOp `json:"update"`
	Insert    []store.InsertOp `json:"insert"`
}

// ParseDiff strips code fences, parses the JSON diff produced by a
// consolidation prompt, and converts string IDs to uuid.UUID. IDs in the
// diff may be either canonical UUIDs OR ordinal refs ("1", "2", …) when a
// non-nil refs map is provided — refs are the on-wire format used by
// consolidation today because LLMs reliably corrupt 36-char UUIDs.
func ParseDiff(text string) (store.MemoryDiff, error) {
	return ParseDiffWithRefs(text, nil)
}

func ParseDiffWithRefs(text string, refs map[string]uuid.UUID) (store.MemoryDiff, error) {
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)
	if text == "" {
		return store.MemoryDiff{}, errors.New("ParseDiff: empty input")
	}

	var r rawDiffFull
	if err := json.Unmarshal([]byte(text), &r); err != nil {
		return store.MemoryDiff{}, fmt.Errorf("ParseDiff: %w", err)
	}

	parseID := func(s, label string) (uuid.UUID, error) {
		s = strings.TrimSpace(s)
		if refs != nil {
			if id, ok := refs[s]; ok {
				return id, nil
			}
			// Fall through to UUID parse — some prompts may still emit a UUID
			// for the rare case where the model echoes one back.
		}
		id, err := uuid.Parse(s)
		if err != nil {
			return uuid.Nil, fmt.Errorf("ParseDiff: invalid ID in %s %q: %w", label, s, err)
		}
		return id, nil
	}

	parseIDs := func(ss []string, label string) ([]uuid.UUID, error) {
		out := make([]uuid.UUID, 0, len(ss))
		for _, s := range ss {
			id, err := parseID(s, label)
			if err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, nil
	}

	keep, err := parseIDs(r.Keep, "keep")
	if err != nil {
		return store.MemoryDiff{}, err
	}
	reinforce, err := parseIDs(r.Reinforce, "reinforce")
	if err != nil {
		return store.MemoryDiff{}, err
	}
	del, err := parseIDs(r.Delete, "delete")
	if err != nil {
		return store.MemoryDiff{}, err
	}

	updates := make([]store.UpdateOp, 0, len(r.Update))
	for _, u := range r.Update {
		id, err := parseID(u.ID, "update")
		if err != nil {
			return store.MemoryDiff{}, err
		}
		updates = append(updates, store.UpdateOp{ID: id, Content: u.Content, Tags: u.Tags})
	}

	return store.MemoryDiff{
		Keep:      keep,
		Reinforce: reinforce,
		Delete:    del,
		Update:    updates,
		Insert:    r.Insert,
	}, nil
}
