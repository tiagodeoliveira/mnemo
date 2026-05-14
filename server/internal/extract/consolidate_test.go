package extract

import (
	"context"
	"strings"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
)

func TestConsolidateAboutFirstWrite(t *testing.T) {
	// "About" always consolidates, even on first write — no existing records.
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		if len(req.Messages) != 1 || req.Messages[0].Role != "user" {
			t.Errorf("expected single user message, got %+v", req.Messages)
		}
		c := req.Messages[0].Content
		if !strings.Contains(c, "ABOUT memory") {
			t.Errorf("missing ABOUT marker: %s", c[:min(200, len(c))])
		}
		if !strings.Contains(c, "(none yet)") {
			t.Errorf("first-write should say (none yet)")
		}
		if !strings.Contains(c, "tiago is a senior engineer") {
			t.Errorf("missing new content")
		}
		return llm.CompleteResponse{Text: "  the actor is a senior engineer.\n"}, nil
	}}
	out, err := Consolidate(context.Background(), stub, "claude-test", DimAbout, nil, "tiago is a senior engineer", "", "2026-05-14", "")
	if err != nil {
		t.Fatal(err)
	}
	if out != "the actor is a senior engineer." {
		t.Fatalf("trim failed: %q", out)
	}
}

func TestConsolidateProjectInjectsName(t *testing.T) {
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		c := req.Messages[0].Content
		if !strings.Contains(c, `PROJECT memory for "mnemo"`) {
			t.Errorf("missing project name injection")
		}
		if !strings.Contains(c, "Record 1:") {
			t.Errorf("existing records not formatted")
		}
		return llm.CompleteResponse{Text: "consolidated"}, nil
	}}
	_, err := Consolidate(context.Background(), stub, "claude-test", DimProject,
		[]string{"prior fact"}, "new fact", "mnemo", "2026-05-14", "2024-01-01")
	if err != nil {
		t.Fatal(err)
	}
}

func TestConsolidateTaskNoNameNeeded(t *testing.T) {
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		c := req.Messages[0].Content
		if !strings.Contains(c, "TASK memory for transferable") {
			t.Errorf("missing TASK type instructions")
		}
		return llm.CompleteResponse{Text: "ok"}, nil
	}}
	_, err := Consolidate(context.Background(), stub, "claude-test", DimTask,
		[]string{"a", "b"}, "new", "", "2026-05-14", "2024-01-01")
	if err != nil {
		t.Fatal(err)
	}
}

func TestConsolidateTruncatedErrors(t *testing.T) {
	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		return llm.CompleteResponse{Text: "...", StopReason: "max_tokens"}, nil
	}}
	_, err := Consolidate(context.Background(), stub, "claude-test", DimAbout, nil, "new", "", "2026-05-14", "")
	var ct *ConsolidationTruncatedError
	if err == nil {
		t.Fatal("expected truncated error")
	}
	if !errorAs(err, &ct) {
		t.Fatalf("wrong error type: %T", err)
	}
}

func TestTruncateToLimit(t *testing.T) {
	short := strings.Repeat("a", 100)
	if TruncateToLimit(short) != short {
		t.Fatal("short input should pass through")
	}
	long := strings.Repeat("b", MaxRecordChars+1000)
	got := TruncateToLimit(long)
	if len(got) != MaxRecordChars {
		t.Fatalf("expected length %d, got %d", MaxRecordChars, len(got))
	}
	if !strings.HasSuffix(got, "\n...") {
		t.Fatal("truncated output should end with marker")
	}
}

func errorAs(err error, target any) bool {
	// stdlib errors.As, manual to avoid import.
	for err != nil {
		switch x := err.(type) {
		case *ConsolidationTruncatedError:
			if t, ok := target.(**ConsolidationTruncatedError); ok {
				*t = x
				return true
			}
		}
		break
	}
	return false
}
