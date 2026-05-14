package extract

import "testing"

func TestParseProjectTaskLogHappyPath(t *testing.T) {
	in := "TASK: coding\nFACTS:\nUses Go for backend services.\nMnemo rewrite started.\nDAILY:\nWorked on the mnemo rewrite. Picked Go for the server."
	got, err := ParseProjectTaskLog(in)
	if err != nil { t.Fatal(err) }
	if got.TaskDomain != "coding" {
		t.Errorf("taskDomain = %q", got.TaskDomain)
	}
	if !contains(got.Facts, "Uses Go") || !contains(got.Facts, "Mnemo") {
		t.Errorf("facts = %q", got.Facts)
	}
	if !contains(got.Daily, "Worked on the mnemo") {
		t.Errorf("daily = %q", got.Daily)
	}
}

func TestParseProjectTaskLogNoneNormalized(t *testing.T) {
	in := "TASK: general\nFACTS:\nNONE\nDAILY:\nNONE"
	got, err := ParseProjectTaskLog(in)
	if err != nil { t.Fatal(err) }
	if got.Facts != "" || got.Daily != "" {
		t.Fatalf("NONE not normalized: facts=%q daily=%q", got.Facts, got.Daily)
	}
}

func TestParseProjectTaskLogDomainSanitization(t *testing.T) {
	in := "TASK: gibberish\nFACTS:\nx\nDAILY:\ny"
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
