package extract

import (
	"testing"

	"github.com/google/uuid"
)

func TestParseProjectTaskLogHappyPath(t *testing.T) {
	in := "TASK: coding\n" +
		"PROJECT_FACTS:\nMnemo server uses sqlx.\n" +
		"TASK_FACTS:\nUses Go for backend services.\n" +
		"DAILY:\nWorked on the mnemo rewrite. Picked Go for the server."
	got, err := ParseProjectTaskLog(in, DefaultTaskDomains)
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

func TestParseProjectTaskLogNoneNormalized(t *testing.T) {
	in := "TASK: general\nPROJECT_FACTS:\nNONE\nTASK_FACTS:\nNONE\nDAILY:\nNONE"
	got, err := ParseProjectTaskLog(in, DefaultTaskDomains)
	if err != nil { t.Fatal(err) }
	if got.ProjectFacts != "" || got.TaskFacts != "" || got.Daily != "" {
		t.Fatalf("NONE not normalized: project=%q task=%q daily=%q",
			got.ProjectFacts, got.TaskFacts, got.Daily)
	}
}

func TestParseProjectTaskLogDomainSanitization(t *testing.T) {
	in := "TASK: gibberish\nPROJECT_FACTS:\nx\nTASK_FACTS:\ny\nDAILY:\nz"
	got, _ := ParseProjectTaskLog(in, DefaultTaskDomains)
	if got.TaskDomain != "general" {
		t.Fatalf("unknown domain should fall back to general, got %q", got.TaskDomain)
	}
}

func TestParseProjectTaskLogMissingTaskErrors(t *testing.T) {
	if _, err := ParseProjectTaskLog("no fields", DefaultTaskDomains); err == nil {
		t.Fatal("expected error for missing TASK")
	}
}

func TestParseProjectTaskLogCustomAllowedList(t *testing.T) {
	custom := []string{"coding", "data-analysis", "writing", "general"}
	in := "TASK: data-analysis\nPROJECT_FACTS:\nx\nTASK_FACTS:\ny\nDAILY:\nz"
	got, err := ParseProjectTaskLog(in, custom)
	if err != nil { t.Fatal(err) }
	if got.TaskDomain != "data-analysis" {
		t.Fatalf("custom domain not accepted: got %q", got.TaskDomain)
	}
	// A domain not in the custom list must fall back to general.
	in = "TASK: studying\nPROJECT_FACTS:\nx\nTASK_FACTS:\ny\nDAILY:\nz"
	got, err = ParseProjectTaskLog(in, custom)
	if err != nil { t.Fatal(err) }
	if got.TaskDomain != "general" {
		t.Fatalf("out-of-list domain should coerce to general, got %q", got.TaskDomain)
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

func TestParsePreferencesExtractsFromProse(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			"prose before JSON",
			`The user's preferences are: {"preferences": ["prefers tabs"]}`,
			"prefers tabs",
		},
		{
			"explanation then JSON",
			"Based on the conversation, here is the output:\n{\"preferences\": [\"uses Go for backend\"]}",
			"uses Go for backend",
		},
		{
			"prose after JSON",
			"{\"preferences\": [\"dark mode\"]}\nI hope this helps!",
			"dark mode",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParsePreferences(tc.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got.Preferences) != 1 || got.Preferences[0] != tc.want {
				t.Fatalf("got %+v, want %q", got, tc.want)
			}
		})
	}
}

func TestParseEpisodesExtractsFromProse(t *testing.T) {
	in := `This conversation contains one notable episode: {"episodes": [{"event": "shipped v2", "reflection": "felt great"}]}`
	got, err := ParseEpisodes(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Episodes) != 1 || got.Episodes[0].Event != "shipped v2" {
		t.Fatalf("got %+v", got)
	}
}

func TestStrictUnmarshalNoProse(t *testing.T) {
	// Pure prose with no JSON at all should fail cleanly.
	var out PreferencesOutput
	err := strictUnmarshal("The user did not express any preferences.", &out)
	if err == nil {
		t.Fatal("expected error for pure prose")
	}
}

func TestParseDiffWithRefsTranslatesOrdinals(t *testing.T) {
	id1, _ := uuid.Parse("11111111-1111-1111-1111-111111111111")
	id2, _ := uuid.Parse("22222222-2222-2222-2222-222222222222")
	refs := map[string]uuid.UUID{"1": id1, "2": id2}
	in := `{"keep":["1"],"reinforce":[],"delete":[],"update":[{"id":"2","content":"x","tags":["t"]}],"insert":[]}`
	d, err := ParseDiffWithRefs(in, refs)
	if err != nil { t.Fatal(err) }
	if len(d.Keep) != 1 || d.Keep[0] != id1 {
		t.Errorf("keep: %v", d.Keep)
	}
	if len(d.Update) != 1 || d.Update[0].ID != id2 {
		t.Errorf("update: %v", d.Update)
	}
}

func TestParseDiffWithRefsAcceptsNumericRefs(t *testing.T) {
	// The model frequently emits refs as bare JSON numbers despite the
	// schema saying strings. Belt-and-braces: parser must accept both.
	id1, _ := uuid.Parse("11111111-1111-1111-1111-111111111111")
	id2, _ := uuid.Parse("22222222-2222-2222-2222-222222222222")
	refs := map[string]uuid.UUID{"1": id1, "2": id2}
	in := `{"keep":[1],"reinforce":[],"delete":[],"update":[{"id":2,"content":"x","tags":["t"]}],"insert":[]}`
	d, err := ParseDiffWithRefs(in, refs)
	if err != nil { t.Fatal(err) }
	if len(d.Keep) != 1 || d.Keep[0] != id1 {
		t.Errorf("numeric keep ref not translated: %v", d.Keep)
	}
	if len(d.Update) != 1 || d.Update[0].ID != id2 {
		t.Errorf("numeric update ref not translated: %v", d.Update)
	}
}

func TestParseDiffWithRefsRejectsUnknownRef(t *testing.T) {
	// Without a map entry for "99", neither ref lookup nor UUID parse succeeds.
	refs := map[string]uuid.UUID{"1": uuid.New()}
	in := `{"keep":["99"],"reinforce":[],"delete":[],"update":[],"insert":[]}`
	if _, err := ParseDiffWithRefs(in, refs); err == nil {
		t.Fatal("expected error on unknown ref")
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
