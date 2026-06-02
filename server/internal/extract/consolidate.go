package extract

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// ConsolidationKind selects which system prompt the consolidator uses.
type ConsolidationKind string

const (
	KindConsolidatePreferences ConsolidationKind = "preferences"
	KindConsolidateAbout       ConsolidationKind = "about"
	KindConsolidateProject     ConsolidationKind = "project"
	KindConsolidateTask        ConsolidationKind = "task"
)

// ConsolidationContext supplies dimension-specific info for prompts.
type ConsolidationContext struct {
	Today      string // YYYY-MM-DD UTC
	Project    string // only used for KindConsolidateProject
	TaskDomain string // only used for KindConsolidateTask
}

// ItemRef describes an existing memory item shown to the LLM during consolidation.
type ItemRef struct {
	ID              uuid.UUID
	Content         string
	Tags            []string
	CreatedAt       string // YYYY-MM-DD
	LastReinforced  string // YYYY-MM-DD
	ReinforcedCount int
}

// NewItem is a freshly-extracted item presented to the LLM as a candidate.
type NewItem struct {
	Content string
	Tags    []string
}

// ConsolidationDiffError signals a parse/validation failure on the diff.
type ConsolidationDiffError struct {
	Msg string
}

func (e *ConsolidationDiffError) Error() string {
	return fmt.Sprintf("consolidation diff error: %s", e.Msg)
}

// ConsolidateResult is the return type of ConsolidateItems.
type ConsolidateResult struct {
	Diff       store.MemoryDiff
	IsDegraded bool   // true when JSON parse failed and fell back to insert-only
	LastError  string // populated when IsDegraded is true
}

// ConsolidateItems calls the LLM once to produce a MemoryDiff merging existing
// items with newly-extracted items. On JSON parse failure it returns an
// insert-only diff with IsDegraded=true. Overlap/hallucination resolution
// happens later in ApplyMemoryDiff.
func ConsolidateItems(
	ctx context.Context,
	cli llm.Client,
	model string,
	kind ConsolidationKind,
	cctx ConsolidationContext,
	existing []ItemRef,
	incoming []NewItem,
) (ConsolidateResult, error) {
	systemPrompt := buildSystemPrompt(kind, cctx)
	userMsg, refs := buildUserMessage(cctx.Today, existing, incoming)

	raw, truncated, err := callLLM(ctx, cli, model, systemPrompt, userMsg)
	if err != nil {
		return ConsolidateResult{}, err
	}
	if truncated {
		return ConsolidateResult{}, &ConsolidationDiffError{Msg: "LLM hit max_tokens on consolidation"}
	}

	diff, perr := ParseDiffWithRefs(raw, refs)
	if perr != nil {
		// JSON parse failure — degrade to insert-only.
		slog.Warn("consolidation diff parse failed, degrading to insert-only",
			"kind", kind, "err", perr)
		return degradedResult(incoming, perr.Error()), nil
	}

	return ConsolidateResult{Diff: diff}, nil
}

func callLLM(ctx context.Context, cli llm.Client, model, system, userMsg string) (text string, truncated bool, err error) {
	resp, err := cli.Complete(ctx, llm.CompleteRequest{
		Model:     model,
		System:    system,
		Messages:  []llm.Message{{Role: "user", Content: userMsg}},
		MaxTokens: llm.LongFormMaxTokens,
	})
	if err != nil {
		return "", false, err
	}
	if resp.StopReason == "max_tokens" {
		return "", true, nil
	}
	return strings.TrimSpace(resp.Text), false, nil
}

func buildSystemPrompt(kind ConsolidationKind, cctx ConsolidationContext) string {
	switch kind {
	case KindConsolidateProject:
		name := cctx.Project
		if name == "" {
			name = "unknown"
		}
		return fmt.Sprintf(SystemConsolidateProject, name)
	case KindConsolidateTask:
		domain := cctx.TaskDomain
		if domain == "" {
			domain = "general"
		}
		return fmt.Sprintf(SystemConsolidateTask, domain)
	case KindConsolidateAbout:
		return SystemConsolidateAbout
	default: // KindConsolidatePreferences
		return SystemConsolidatePreferences
	}
}

// buildUserMessage emits the consolidation prompt body with ordinal refs in
// place of UUIDs ("ref: 1", "ref: 2", …). The returned map translates the
// LLM's refs back to UUIDs at parse time. Ordinals are used because Claude/
// GPT routinely typo 36-char UUIDs (dropped char, missing dash) — single-
// digit refs are nearly impossible to corrupt and cost ~30 fewer tokens
// per item across input and output.
func buildUserMessage(today string, existing []ItemRef, incoming []NewItem) (string, map[string]uuid.UUID) {
	var b strings.Builder
	fmt.Fprintf(&b, "Today's date: %s\n\n", today)

	refs := make(map[string]uuid.UUID, len(existing))
	b.WriteString("EXISTING ITEMS:\n")
	if len(existing) == 0 {
		b.WriteString("(none)\n")
	} else {
		for i, it := range existing {
			ref := fmt.Sprintf("%d", i+1)
			refs[ref] = it.ID
			tags := strings.Join(it.Tags, ", ")
			if tags == "" {
				tags = "(none)"
			}
			fmt.Fprintf(&b, "[ref: %s, created: %s, last_reinforced: %s, count: %d, tags: [%s]]\n%s\n\n",
				ref, it.CreatedAt, it.LastReinforced, it.ReinforcedCount, tags, it.Content)
		}
	}

	b.WriteString("NEW EXTRACTED ITEMS:\n")
	if len(incoming) == 0 {
		b.WriteString("(none)\n")
	} else {
		for _, it := range incoming {
			tags := strings.Join(it.Tags, ", ")
			if tags == "" {
				tags = "(suggested)"
			}
			fmt.Fprintf(&b, "[tags: %s]\n%s\n\n", tags, it.Content)
		}
	}

	return strings.TrimRight(b.String(), "\n"), refs
}

func degradedResult(incoming []NewItem, lastErr string) ConsolidateResult {
	inserts := make([]store.InsertOp, 0, len(incoming))
	for _, it := range incoming {
		if strings.TrimSpace(it.Content) == "" {
			continue
		}
		inserts = append(inserts, store.InsertOp{Content: it.Content, Tags: it.Tags})
	}
	return ConsolidateResult{
		Diff:       store.MemoryDiff{Insert: inserts},
		IsDegraded: true,
		LastError:  lastErr,
	}
}
