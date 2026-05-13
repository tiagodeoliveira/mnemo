package extract

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
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

// PreferencesOutput is the JSON shape from SystemPreferences.
type PreferencesOutput struct {
	Preferences []string `json:"preferences"`
}

// FactsEpisodesOutput is the JSON shape from SystemFactsEpisodes.
type FactsEpisodesOutput struct {
	Facts    []string `json:"facts"`
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

func ParseFactsEpisodes(s string) (FactsEpisodesOutput, error) {
	var out FactsEpisodesOutput
	return out, strictUnmarshal(s, &out)
}
