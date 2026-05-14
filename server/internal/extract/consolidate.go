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

// ConsolidationTruncatedError is an alias for ConsolidationDiffError kept for
// backward compatibility with callers that may check for it.
type ConsolidationTruncatedError = ConsolidationDiffError

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
	userMsg := buildUserMessage(cctx.Today, existing, incoming)

	raw, truncated, err := callLLM(ctx, cli, model, systemPrompt, userMsg)
	if err != nil {
		return ConsolidateResult{}, err
	}
	if truncated {
		return ConsolidateResult{}, &ConsolidationDiffError{Msg: "LLM hit max_tokens on consolidation"}
	}

	diff, perr := ParseDiff(raw)
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
		MaxTokens: 4096,
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

func buildUserMessage(today string, existing []ItemRef, incoming []NewItem) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Today's date: %s\n\n", today)

	b.WriteString("EXISTING ITEMS:\n")
	if len(existing) == 0 {
		b.WriteString("(none)\n")
	} else {
		for _, it := range existing {
			tags := strings.Join(it.Tags, ", ")
			if tags == "" {
				tags = "(none)"
			}
			fmt.Fprintf(&b, "[id: %s, created: %s, last_reinforced: %s, count: %d, tags: [%s]]\n%s\n\n",
				it.ID, it.CreatedAt, it.LastReinforced, it.ReinforcedCount, tags, it.Content)
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

	return strings.TrimRight(b.String(), "\n")
}

func validateDiff(d store.MemoryDiff, existing []ItemRef) error {
	// Build set of valid IDs.
	valid := make(map[uuid.UUID]bool, len(existing))
	for _, it := range existing {
		valid[it.ID] = true
	}

	// Track which IDs have been assigned an operation.
	seen := make(map[uuid.UUID]string)

	check := func(id uuid.UUID, op string) error {
		if !valid[id] {
			return fmt.Errorf("unknown ID %s in %s", id, op)
		}
		if prev, ok := seen[id]; ok {
			return fmt.Errorf("ID %s appears in both %s and %s", id, prev, op)
		}
		seen[id] = op
		return nil
	}

	for _, id := range d.Keep {
		if err := check(id, "keep"); err != nil {
			return err
		}
	}
	for _, id := range d.Reinforce {
		if err := check(id, "reinforce"); err != nil {
			return err
		}
	}
	for _, id := range d.Delete {
		if err := check(id, "delete"); err != nil {
			return err
		}
	}
	for _, op := range d.Update {
		if err := check(op.ID, "update"); err != nil {
			return err
		}
		if strings.TrimSpace(op.Content) == "" {
			return fmt.Errorf("update op for %s has empty content", op.ID)
		}
	}

	// Validate inserts.
	for i, op := range d.Insert {
		if strings.TrimSpace(op.Content) == "" {
			return fmt.Errorf("insert[%d] has empty content", i)
		}
	}

	// Every existing item must be covered.
	for _, it := range existing {
		if _, ok := seen[it.ID]; !ok {
			return fmt.Errorf("existing item %s not covered by diff (must appear in keep/reinforce/delete/update)", it.ID)
		}
	}

	return nil
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
