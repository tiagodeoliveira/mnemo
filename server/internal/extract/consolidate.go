package extract

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
)

// MaxRecordChars is the hard limit on consolidated content length.
// Mirrors AGENTCORE_RECORD_LIMIT in infra/lambda/context-extractor/index.ts (16000).
const MaxRecordChars = 16000

// DimensionKind identifies which consolidation template to use.
type DimensionKind string

const (
	DimAbout        DimensionKind = "about"
	DimProject      DimensionKind = "project"
	DimTask         DimensionKind = "task"
	DimPreferences  DimensionKind = "preferences"
)

// ConsolidationTruncatedError signals the LLM hit max_tokens and produced a
// truncated record; callers should treat as a hard failure rather than write
// the partial result. Mirrors the TS ConsolidationTruncatedError.
type ConsolidationTruncatedError struct {
	Dim DimensionKind
}

func (e *ConsolidationTruncatedError) Error() string {
	return fmt.Sprintf("consolidation for %s hit max_tokens — refusing to write truncated record", e.Dim)
}

// Consolidate merges existing records with new content into one distilled
// record. Sends the full prompt as a single user message (no system prompt),
// matching the TS production behavior.
//
// existingRecords: prior content for the namespace, in insertion order. Empty
// for first write.
// newContent: the newly-extracted text (Facts for project/task, About blob for about).
// metaProject: passed through to the project type-instructions. Ignored for task and about.
//
// Returns the cleaned LLM output, or a ConsolidationTruncatedError on max_tokens.
func Consolidate(
	ctx context.Context,
	cli llm.Client,
	model string,
	dim DimensionKind,
	existingRecords []string,
	newContent string,
	metaProject string,
) (string, error) {
	prompt, err := buildConsolidationPrompt(dim, existingRecords, newContent, metaProject)
	if err != nil {
		return "", err
	}
	out, err := cli.Complete(ctx, llm.CompleteRequest{
		Model:     model,
		Messages:  []llm.Message{{Role: "user", Content: prompt}},
		MaxTokens: 8192,
	})
	if err != nil {
		return "", err
	}
	if out.StopReason == "max_tokens" {
		return "", &ConsolidationTruncatedError{Dim: dim}
	}
	return strings.TrimSpace(out.Text), nil
}

func buildConsolidationPrompt(dim DimensionKind, existing []string, newContent, project string) (string, error) {
	var existingText string
	if len(existing) == 0 {
		existingText = "(none yet)"
	} else {
		var b strings.Builder
		for i, r := range existing {
			if i > 0 {
				b.WriteString("\n\n")
			}
			fmt.Fprintf(&b, "Record %d:\n%s", i+1, r)
		}
		existingText = b.String()
	}

	switch dim {
	case DimAbout:
		return fmt.Sprintf(SystemAboutConsolidate, existingText, newContent), nil
	case DimProject:
		typeInstr := fmt.Sprintf(
			`This is a PROJECT memory for %q. Keep architecture decisions, design rationale, and system constraints. Drop implementation specifics that belong in the code itself.`,
			sanitizeMetaValue(project),
		)
		return fmt.Sprintf(SystemProjectTaskConsolidate, typeInstr, existingText, newContent), nil
	case DimTask:
		typeInstr := `This is a TASK memory for transferable domain insights. Keep patterns and lessons that apply beyond a single session. Drop session-specific details.`
		return fmt.Sprintf(SystemProjectTaskConsolidate, typeInstr, existingText, newContent), nil
	default:
		return "", errors.New("consolidate: unknown dimension")
	}
}

// sanitizeMetaValue mirrors the TS sanitizeMetaValue helper — strips control
// chars and limits length. For our use (project name in a prompt), a light
// pass that prevents prompt-injection-style escapes is enough.
func sanitizeMetaValue(s string) string {
	if s == "" {
		return "unknown"
	}
	// Drop any unprintable chars and limit to a sane length.
	var b strings.Builder
	for _, r := range s {
		if r >= 32 && r != 127 {
			b.WriteRune(r)
		}
		if b.Len() >= 200 {
			break
		}
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "unknown"
	}
	return out
}

// TruncateToLimit caps text at MaxRecordChars, appending "\n..." if it overflows.
// Use this on the FINAL content before persisting (matching writeMemoryRecord in TS).
func TruncateToLimit(s string) string {
	if len(s) <= MaxRecordChars {
		return s
	}
	return s[:MaxRecordChars-4] + "\n..."
}

// ConsolidateFreshness merges existing record + new content using the
// freshness-aware prompt. Used for preferences (and any future "evolving
// list of statements" dimension). Sends as a single user message, no system
// prompt — matches the Anthropic pattern used by the other consolidation prompts.
//
// today and existingLastUpdated are passed as YYYY-MM-DD strings.
func ConsolidateFreshness(
	ctx context.Context,
	cli llm.Client,
	model string,
	dim DimensionKind,
	today, existingLastUpdated, existingBody, newContent string,
) (string, error) {
	if existingBody == "" {
		existingBody = "(none yet)"
	}
	if existingLastUpdated == "" {
		existingLastUpdated = "(n/a)"
	}
	prompt := fmt.Sprintf(
		SystemFreshnessConsolidate,
		string(dim), today, existingLastUpdated, existingBody, newContent,
	)
	out, err := cli.Complete(ctx, llm.CompleteRequest{
		Model:     model,
		Messages:  []llm.Message{{Role: "user", Content: prompt}},
		MaxTokens: 8192,
	})
	if err != nil {
		return "", err
	}
	if out.StopReason == "max_tokens" {
		return "", &ConsolidationTruncatedError{Dim: dim}
	}
	return strings.TrimSpace(out.Text), nil
}
