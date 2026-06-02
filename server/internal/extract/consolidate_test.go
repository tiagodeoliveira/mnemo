package extract

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
)

// cannedDiff returns a stub LLM handler that returns a valid diff JSON.
// If existingIDs is empty, the diff contains only inserts.
// If existingIDs is non-empty, every ID goes into "keep".
func cannedDiffHandler(existingIDs []uuid.UUID, insertContent string) func(llm.CompleteRequest) (llm.CompleteResponse, error) {
	return func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		keep := make([]string, len(existingIDs))
		for i, id := range existingIDs {
			keep[i] = `"` + id.String() + `"`
		}
		keepJSON := "[" + strings.Join(keep, ",") + "]"
		var inserts string
		if insertContent != "" {
			inserts = `[{"content":"` + insertContent + `","tags":["tool"]}]`
		} else {
			inserts = "[]"
		}
		resp := `{"keep":` + keepJSON + `,"reinforce":[],"delete":[],"update":[],"insert":` + inserts + `}`
		return llm.CompleteResponse{Text: resp}, nil
	}
}

func TestConsolidateItemsFirstWrite(t *testing.T) {
	// No existing items — all incoming become inserts.
	stub := &llm.Stub{Handler: cannedDiffHandler(nil, "uses Go for backend services")}
	result, err := ConsolidateItems(
		context.Background(), stub, "claude-test",
		KindConsolidatePreferences,
		ConsolidationContext{Today: "2026-05-14"},
		nil, // no existing items
		[]NewItem{{Content: "uses Go for backend services", Tags: []string{"language"}}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsDegraded {
		t.Errorf("expected clean result, got degraded: %s", result.LastError)
	}
	if len(result.Diff.Insert) != 1 {
		t.Fatalf("expected 1 insert, got %d", len(result.Diff.Insert))
	}
	if result.Diff.Insert[0].Content != "uses Go for backend services" {
		t.Errorf("unexpected insert content: %s", result.Diff.Insert[0].Content)
	}
}

func TestConsolidateItemsReinforceExisting(t *testing.T) {
	existingID := uuid.New()
	// LLM puts the existing item into "reinforce" and adds nothing new.
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		resp := `{"keep":[],"reinforce":["` + existingID.String() + `"],"delete":[],"update":[],"insert":[]}`
		return llm.CompleteResponse{Text: resp}, nil
	}}
	existing := []ItemRef{{
		ID:              existingID,
		Content:         "uses Go for backend services",
		Tags:            []string{"language"},
		CreatedAt:       "2026-01-01",
		LastReinforced:  "2026-04-01",
		ReinforcedCount: 3,
	}}
	result, err := ConsolidateItems(
		context.Background(), stub, "claude-test",
		KindConsolidatePreferences,
		ConsolidationContext{Today: "2026-05-14"},
		existing,
		[]NewItem{{Content: "uses Go for backend services", Tags: []string{"language"}}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsDegraded {
		t.Errorf("expected clean result, got degraded: %s", result.LastError)
	}
	if len(result.Diff.Reinforce) != 1 || result.Diff.Reinforce[0] != existingID {
		t.Errorf("expected reinforce of %s, got %+v", existingID, result.Diff)
	}
}

func TestConsolidateItemsTruncatedReturnsError(t *testing.T) {
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		return llm.CompleteResponse{Text: "...", StopReason: "max_tokens"}, nil
	}}
	_, err := ConsolidateItems(
		context.Background(), stub, "claude-test",
		KindConsolidatePreferences,
		ConsolidationContext{Today: "2026-05-14"},
		nil,
		[]NewItem{{Content: "some pref"}},
	)
	if err == nil {
		t.Fatal("expected error on max_tokens")
	}
	var ce *ConsolidationDiffError
	if !errorAs(err, &ce) {
		t.Fatalf("expected ConsolidationDiffError, got %T: %v", err, err)
	}
}

func TestConsolidateItemsDegradedOnBadDiff(t *testing.T) {
	// LLM returns malformed JSON — should degrade to insert-only.
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		return llm.CompleteResponse{Text: "not json at all"}, nil
	}}
	result, err := ConsolidateItems(
		context.Background(), stub, "claude-test",
		KindConsolidatePreferences,
		ConsolidationContext{Today: "2026-05-14"},
		nil,
		[]NewItem{{Content: "pref A"}, {Content: "pref B"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsDegraded {
		t.Error("expected degraded=true")
	}
	if len(result.Diff.Insert) != 2 {
		t.Errorf("expected 2 inserts in degraded mode, got %d", len(result.Diff.Insert))
	}
}

func TestConsolidateItemsUnknownIDPassesThrough(t *testing.T) {
	// LLM references a UUID that is not in existing — consolidate no longer
	// validates IDs (resolution happens in ApplyMemoryDiff). The diff parses
	// fine and is returned non-degraded.
	unknownID := uuid.New()
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		resp := `{"keep":["` + unknownID.String() + `"],"reinforce":[],"delete":[],"update":[],"insert":[]}`
		return llm.CompleteResponse{Text: resp}, nil
	}}
	result, err := ConsolidateItems(
		context.Background(), stub, "claude-test",
		KindConsolidatePreferences,
		ConsolidationContext{Today: "2026-05-14"},
		nil, // no existing items
		[]NewItem{{Content: "some pref"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsDegraded {
		t.Error("expected non-degraded: unknown IDs are resolved in ApplyMemoryDiff, not here")
	}
	if len(result.Diff.Keep) != 1 || result.Diff.Keep[0] != unknownID {
		t.Errorf("expected keep to contain unknownID, got %v", result.Diff.Keep)
	}
}

func TestConsolidateItemsAllDimensionKinds(t *testing.T) {
	// Smoke test that each kind's prompt is built without panicking.
	for _, kind := range []ConsolidationKind{
		KindConsolidatePreferences, KindConsolidateAbout,
		KindConsolidateProject, KindConsolidateTask,
	} {
		kind := kind
		t.Run(string(kind), func(t *testing.T) {
			stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
				if req.System == "" {
					t.Error("expected non-empty system prompt")
				}
				return llm.CompleteResponse{Text: `{"keep":[],"reinforce":[],"delete":[],"update":[],"insert":[{"content":"x","tags":[]}]}`}, nil
			}}
			_, err := ConsolidateItems(
				context.Background(), stub, "claude-test", kind,
				ConsolidationContext{Today: "2026-05-14", Project: "test", TaskDomain: "coding"},
				nil,
				[]NewItem{{Content: "fact"}},
			)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestParseDiffHappy(t *testing.T) {
	id1 := uuid.New()
	id2 := uuid.New()
	raw, _ := json.Marshal(map[string]any{
		"keep":      []string{id1.String()},
		"reinforce": []string{id2.String()},
		"delete":    []string{},
		"update":    []map[string]any{},
		"insert":    []map[string]any{{"content": "new pref", "tags": []string{"tool"}}},
	})
	d, err := ParseDiffWithRefs(string(raw), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Keep) != 1 || d.Keep[0] != id1 {
		t.Errorf("keep: %v", d.Keep)
	}
	if len(d.Reinforce) != 1 || d.Reinforce[0] != id2 {
		t.Errorf("reinforce: %v", d.Reinforce)
	}
	if len(d.Insert) != 1 || d.Insert[0].Content != "new pref" {
		t.Errorf("insert: %v", d.Insert)
	}
}

func TestParseDiffStripsCodeFence(t *testing.T) {
	id := uuid.New()
	raw := "```json\n" + `{"keep":["` + id.String() + `"],"reinforce":[],"delete":[],"update":[],"insert":[]}` + "\n```"
	d, err := ParseDiffWithRefs(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Keep) != 1 || d.Keep[0] != id {
		t.Errorf("expected keep=%s, got %v", id, d.Keep)
	}
}

func TestParseDiffInvalidUUIDErrors(t *testing.T) {
	raw := `{"keep":["not-a-uuid"],"reinforce":[],"delete":[],"update":[],"insert":[]}`
	_, err := ParseDiffWithRefs(raw, nil)
	if err == nil {
		t.Fatal("expected error on invalid UUID")
	}
}

func TestBuildUserMessageExistingAndIncoming(t *testing.T) {
	id := uuid.New()
	existing := []ItemRef{{
		ID:              id,
		Content:         "uses Go",
		Tags:            []string{"language"},
		CreatedAt:       "2026-01-01",
		LastReinforced:  "2026-04-01",
		ReinforcedCount: 5,
	}}
	incoming := []NewItem{{Content: "likes Rust", Tags: []string{"language"}}}
	msg, refs := buildUserMessage("2026-05-14", existing, incoming)
	if !strings.Contains(msg, "ref: 1") {
		t.Error("user message missing ordinal ref for existing item")
	}
	if strings.Contains(msg, id.String()) {
		t.Error("user message must not leak full UUID — LLM corrupts them")
	}
	if !strings.Contains(msg, "uses Go") {
		t.Error("user message missing existing item content")
	}
	if !strings.Contains(msg, "likes Rust") {
		t.Error("user message missing incoming item content")
	}
	if refs["1"] != id {
		t.Errorf("refs[\"1\"] = %s, want %s", refs["1"], id)
	}
}

func errorAs(err error, target any) bool {
	if err != nil {
		if t, ok := target.(**ConsolidationDiffError); ok {
			if x, ok2 := err.(*ConsolidationDiffError); ok2 {
				*t = x
				return true
			}
		}
	}
	return false
}
