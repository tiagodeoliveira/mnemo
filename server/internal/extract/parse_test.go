package extract

import "testing"

func TestParseProjectTaskLogHappyPath(t *testing.T) {
	in := "TASK: coding\n" +
		"PROJECT_FACTS:\nMnemo server uses sqlx.\n" +
		"TASK_FACTS:\nUses Go for backend services.\n" +
		"DAILY:\nWorked on the mnemo rewrite. Picked Go for the server."
	got, err := ParseProjectTaskLog(in)
	if err != nil { t.Fatal(err) }
	if got.TaskDomain != "coding" {
		t.Errorf("taskDomain = %q", got.TaskDomain)
	}
	if !contains(got.ProjectFacts, "Mnemo server") {
		t.Errorf("project facts = %q", got.ProjectFacts)
	}
	if !contains(got.TaskFacts, "Uses Go") {
		t.Errorf("task facts = %q", got.TaskFacts)
	}
	if !contains(got.Daily, "Worked on the mnemo") {
		t.Errorf("daily = %q", got.Daily)
	}
}

func TestParseProjectTaskLogLegacySingleFacts(t *testing.T) {
	// Backward compat: pre-split responses use FACTS: and should land in TaskFacts
	// so nothing is silently dropped while old in-flight jobs drain.
	in := "TASK: coding\nFACTS:\nUses Go for backend.\nDAILY:\nlog body"
	got, err := ParseProjectTaskLog(in)
	if err != nil { t.Fatal(err) }
	if got.ProjectFacts != "" {
		t.Errorf("legacy facts must not leak into project bucket, got %q", got.ProjectFacts)
	}
	if !contains(got.TaskFacts, "Uses Go") {
		t.Errorf("legacy facts should fall back into task bucket, got %q", got.TaskFacts)
	}
}

func TestParseProjectTaskLogNoneNormalized(t *testing.T) {
	in := "TASK: general\nPROJECT_FACTS:\nNONE\nTASK_FACTS:\nNONE\nDAILY:\nNONE"
	got, err := ParseProjectTaskLog(in)
	if err != nil { t.Fatal(err) }
	if got.ProjectFacts != "" || got.TaskFacts != "" || got.Daily != "" {
		t.Fatalf("NONE not normalized: project=%q task=%q daily=%q",
			got.ProjectFacts, got.TaskFacts, got.Daily)
	}
}

func TestParseProjectTaskLogDomainSanitization(t *testing.T) {
	in := "TASK: gibberish\nPROJECT_FACTS:\nx\nTASK_FACTS:\ny\nDAILY:\nz"
	got, _ := ParseProjectTaskLog(in)
	if got.TaskDomain != "general" {
		t.Fatalf("unknown domain should fall back to general, got %q", got.TaskDomain)
	}
}

func TestParseProjectTaskLogMissingTaskErrors(t *testing.T) {
	if _, err := ParseProjectTaskLog("no fields"); err == nil {
		t.Fatal("expected error for missing TASK")
	}
}

func TestParsePreferencesStripsCodeFence(t *testing.T) {
	in := "```json\n{\"preferences\":[\"use Go\"]}\n```"
	got, err := ParsePreferences(in)
	if err != nil { t.Fatal(err) }
	if len(got.Preferences) != 1 || got.Preferences[0] != "use Go" {
		t.Fatalf("got %+v", got)
	}
}

func TestParseEpisodes(t *testing.T) {
	in := `{"episodes":[{"event":"shipped X","reflection":"felt good"}]}`
	got, err := ParseEpisodes(in)
	if err != nil { t.Fatal(err) }
	if got.Episodes[0].Event != "shipped X" {
		t.Fatalf("parse: %+v", got)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub { return i }
	}
	return -1
}
