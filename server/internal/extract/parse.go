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

// ProjectTaskLog mirrors the TS ExtractionResult parsed from the custom
// TASK:/FACTS:/DAILY: format. See infra/lambda/context-extractor/index.ts:200-221.
type ProjectTaskLog struct {
	TaskDomain string // sanitized lower-snake-case; "unknown" if missing, "general" if outside allowed list
	Facts      string // multi-line text; "" if NONE or absent
	Daily      string // multi-line text; "" if NONE or absent
}

// AllowedDomains is the canonical task-domain list. Mirrors getTaskDomains() in the TS.
var AllowedDomains = []string{"coding", "studying", "meeting", "general"}

var taskRE = regexp.MustCompile(`(?im)^TASK:\s*(.+)$`)
var factsRE = regexp.MustCompile(`(?im)^FACTS:\s*\n([\s\S]*?)\nDAILY:`)
var dailyRE = regexp.MustCompile(`(?im)^DAILY:\s*\n?([\s\S]*)$`)

// ParseProjectTaskLog parses the custom format from the project/task/daily-log prompt.
// Returns the zero-value struct + an error if the TASK line is missing.
// "NONE" or empty body in FACTS/DAILY is normalized to "".
func ParseProjectTaskLog(text string) (ProjectTaskLog, error) {
	out := ProjectTaskLog{TaskDomain: "unknown"}
	tm := taskRE.FindStringSubmatch(text)
	if len(tm) < 2 {
		return out, errors.New("parse: no TASK line found")
	}
	out.TaskDomain = sanitizeDomain(strings.TrimSpace(tm[1]))

	if fm := factsRE.FindStringSubmatch(text); len(fm) >= 2 {
		s := strings.TrimSpace(fm[1])
		if !isNone(s) {
			out.Facts = s
		}
	}
	if dm := dailyRE.FindStringSubmatch(text); len(dm) >= 2 {
		s := strings.TrimSpace(dm[1])
		if !isNone(s) {
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
// consolidation prompt, and converts string IDs to uuid.UUID.
func ParseDiff(text string) (store.MemoryDiff, error) {
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

	parseIDs := func(ss []string, label string) ([]uuid.UUID, error) {
		out := make([]uuid.UUID, 0, len(ss))
		for _, s := range ss {
			id, err := uuid.Parse(strings.TrimSpace(s))
			if err != nil {
				return nil, fmt.Errorf("ParseDiff: invalid UUID in %s %q: %w", label, s, err)
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
		id, err := uuid.Parse(strings.TrimSpace(u.ID))
		if err != nil {
			return store.MemoryDiff{}, fmt.Errorf("ParseDiff: invalid UUID in update %q: %w", u.ID, err)
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
