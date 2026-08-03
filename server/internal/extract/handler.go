package extract

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// maxConsolidationItems caps how many existing items per namespace are shown
// to the consolidation LLM. Hot namespaces (active project/task buckets,
// per-actor preferences) accumulate across every conversation with no
// natural shedding — reinforcement resets the TTL — so without a cap the
// prompt eventually exceeds the model's context window. 200 items at the
// observed ~150 tokens/item ≈ 30k prompt tokens, leaving headroom for new
// items and the LongFormMaxTokens completion reservation.
const maxConsolidationItems = 200

// defaultTTLDays maps dimension name to TTL in days. 0 = never expires.
//
// about and preferences use reinforcement-decay: a finite TTL for unreinforced
// facts, but ApplyMemoryDiff promotes a fact to permanent once it has been
// corroborated promoteAtReinforced times (see PromoteAtReinforced). This bounds
// the long tail of one-off session narration that was burying durable facts,
// while genuinely recurring identity/preference facts stick forever.
var defaultTTLDays = map[string]int{
	"preferences":   90,
	"about":         60,
	"project":       0,
	"task":          365,
	"daily_log":     365,
	"episodes":      0,
	"daily_summary": 365,
	"meeting":       0,
}

// promoteAtReinforced is the reinforcement count at which a decaying about/
// preferences fact graduates to permanent (expires_at = NULL). 3 means a fact
// must recur across at least three extractions to be treated as durable.
const promoteAtReinforced = 3

type Handler struct {
	Store         *store.Store
	LLM           llm.Client
	Model         string
	Embed         embed.Client
	EmbedDisabled bool
}

type contextPayload struct {
	ActorID string    `json:"actor_id"`
	EventID uuid.UUID `json:"event_id"`
}

func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) error {
	var p contextPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}

	var (
		project   sql.NullString
		workdir   sql.NullString
		turnsRaw  json.RawMessage
		createdAt time.Time
	)
	if err := h.Store.DB.QueryRowContext(ctx,
		`SELECT project, workdir, turns, created_at FROM events WHERE event_id = $1`,
		p.EventID,
	).Scan(&project, &workdir, &turnsRaw, &createdAt); err != nil {
		return fmt.Errorf("load event: %w", err)
	}

	actor, err := h.Store.GetActor(ctx, p.ActorID)
	if err != nil {
		return fmt.Errorf("load actor: %w", err)
	}
	if actor == nil {
		return fmt.Errorf("actor %s not found", p.ActorID)
	}

	turnsText := turnsToText(turnsRaw)
	projectName := project.String
	date := createdAt.UTC().Format("2006-01-02")
	today := time.Now().UTC().Format("2006-01-02")

	// Per-actor classifier vocabulary. Falls back to the seeded defaults if
	// the column is empty for any reason (e.g. legacy actor row).
	domains := actor.TaskDomains
	if len(domains) == 0 {
		domains = DefaultTaskDomains
	}

	classifierPrompt := fmt.Sprintf(
		SystemExtractClassifier,
		buildMetaSection(projectName, workdir.String),
		buildDomainList(domains),
	) + "\n\nCONVERSATION:\n" + turnsText

	// The about and preferences extractors see only the actor's own (user)
	// turns — see userTurnsToText. A coding session is mostly assistant
	// narration and tool output; feeding that to these extractors made the
	// model mine assistant narration ("manages tokens proactively...",
	// "uses Docker multi-tagging strategy...") as if it were a fact about
	// the actor. With no user turns there is nothing to find, so skip the
	// call entirely.
	aboutTurns := userTurnsToText(turnsRaw)
	aboutPrompt := SystemExtractAbout + "\n\nCONVERSATION:\n" + aboutTurns
	prefTurns := userTurnsToText(turnsRaw)

	g, gctx := errgroup.WithContext(ctx)

	var ptl ProjectTaskLog
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model:     h.Model,
			Messages:  []llm.Message{{Role: "user", Content: classifierPrompt}},
			MaxTokens: 1024,
		})
		if err != nil {
			return err
		}
		ptl, err = ParseProjectTaskLog(out.Text, domains)
		return err
	})

	var aboutItems []NewItem
	if aboutTurns != "" {
		g.Go(func() error {
			out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
				Model:     h.Model,
				Messages:  []llm.Message{{Role: "user", Content: aboutPrompt}},
				MaxTokens: 1024,
			})
			if err != nil {
				return err
			}
			aboutItems = ParseAbout(out.Text)
			return nil
		})
	}

	var prefs PreferencesOutput
	if prefTurns != "" {
		g.Go(func() error {
			out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
				Model:     h.Model,
				System:    SystemExtractPreferences,
				Messages:  []llm.Message{{Role: "user", Content: prefTurns}},
				MaxTokens: 512,
			})
			if err != nil {
				return err
			}
			prefs, err = ParsePreferences(out.Text)
			if err != nil {
				slog.Warn("preferences parse failed, treating as empty", "err", err)
			}
			return nil
		})
	}

	var ep EpisodesOutput
	episodesEnabled := actor.EpisodeStrategy != "disabled"
	if episodesEnabled {
		g.Go(func() error {
			out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
				Model:     h.Model,
				System:    SystemExtractEpisodes,
				Messages:  []llm.Message{{Role: "user", Content: turnsText}},
				MaxTokens: 768,
			})
			if err != nil {
				return err
			}
			ep, err = ParseEpisodes(out.Text)
			if err != nil {
				slog.Warn("episodes parse failed, treating as empty", "err", err)
			}
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	// Build NewItem slices per dimension. The classifier emits PROJECT_FACTS
	// and TASK_FACTS as separate buckets so the same line never lands in both.
	var projectItems []NewItem
	if projectName != "" && ptl.ProjectFacts != "" {
		for _, line := range strings.Split(ptl.ProjectFacts, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || isNone(line) {
				continue
			}
			projectItems = append(projectItems, NewItem{Content: line, Tags: []string{"architecture"}})
		}
	}

	var taskItems []NewItem
	if ptl.TaskDomain != "unknown" && ptl.TaskFacts != "" {
		for _, line := range strings.Split(ptl.TaskFacts, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || isNone(line) {
				continue
			}
			taskItems = append(taskItems, NewItem{Content: line, Tags: []string{"pattern"}})
		}
	}

	var prefItems []NewItem
	for _, pref := range prefs.Preferences {
		if strings.TrimSpace(pref) == "" {
			continue
		}
		prefItems = append(prefItems, NewItem{Content: pref, Tags: []string{}})
	}

	hasProject := len(projectItems) > 0
	hasTask := len(taskItems) > 0
	hasDaily := !isNone(ptl.Daily) && ptl.Daily != ""
	hasAbout := len(aboutItems) > 0
	hasPreferences := len(prefItems) > 0

	// ttlFor returns the effective TTL in days for a dimension, respecting per-actor overrides.
	ttlFor := func(dim string) int {
		if v, ok := actor.TTLOverrides[dim]; ok {
			return v
		}
		return defaultTTLDays[dim]
	}

	// Consolidation LLM calls happen OUTSIDE the tx (they can take seconds).
	cctx := ConsolidationContext{Today: today, Project: projectName, TaskDomain: ptl.TaskDomain}

	var (
		projectDiff       store.DiffApplyOpts
		projectDiffResult ConsolidateResult
		taskDiff          store.DiffApplyOpts
		taskDiffResult    ConsolidateResult
		aboutDiff         store.DiffApplyOpts
		aboutDiffResult   ConsolidateResult
		prefsDiff         store.DiffApplyOpts
		prefsDiffResult   ConsolidateResult
	)

	if hasProject {
		ns := fmt.Sprintf("/projects/%s/%s/", p.ActorID, projectName)
		existing, err := h.existingItemRefs(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		result, err := ConsolidateItems(ctx, h.LLM, h.Model, KindConsolidateProject, cctx, existing, projectItems)
		if err != nil {
			return err
		}
		if result.IsDegraded {
			slog.Warn("project consolidation degraded", "actor", p.ActorID, "err", result.LastError)
		}
		projectDiffResult = result
		projectDiff = store.DiffApplyOpts{
			ActorID: p.ActorID, Dimension: "project", Namespace: ns,
			SourceEventID: p.EventID, TTLDays: ttlFor("project"),
		}
	}

	if hasTask {
		ns := fmt.Sprintf("/tasks/%s/%s/", p.ActorID, ptl.TaskDomain)
		existing, err := h.existingItemRefs(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		result, err := ConsolidateItems(ctx, h.LLM, h.Model, KindConsolidateTask, cctx, existing, taskItems)
		if err != nil {
			return err
		}
		if result.IsDegraded {
			slog.Warn("task consolidation degraded", "actor", p.ActorID, "err", result.LastError)
		}
		taskDiffResult = result
		taskDiff = store.DiffApplyOpts{
			ActorID: p.ActorID, Dimension: "task",
			Namespace:     fmt.Sprintf("/tasks/%s/%s/", p.ActorID, ptl.TaskDomain),
			SourceEventID: p.EventID, TTLDays: ttlFor("task"),
		}
	}

	if hasAbout {
		ns := fmt.Sprintf("/about/%s/", p.ActorID)
		existing, err := h.existingItemRefs(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		result, err := ConsolidateItems(ctx, h.LLM, h.Model, KindConsolidateAbout, cctx, existing, aboutItems)
		if err != nil {
			return err
		}
		if result.IsDegraded {
			slog.Warn("about consolidation degraded", "actor", p.ActorID, "err", result.LastError)
		}
		aboutDiffResult = result
		aboutDiff = store.DiffApplyOpts{
			ActorID: p.ActorID, Dimension: "about", Namespace: fmt.Sprintf("/about/%s/", p.ActorID),
			SourceEventID: p.EventID, TTLDays: ttlFor("about"),
			PromoteAtReinforced: promoteAtReinforced,
		}
	}

	if hasPreferences {
		ns := fmt.Sprintf("/preferences/%s/", p.ActorID)
		existing, err := h.existingItemRefs(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		result, err := ConsolidateItems(ctx, h.LLM, h.Model, KindConsolidatePreferences, cctx, existing, prefItems)
		if err != nil {
			return err
		}
		if result.IsDegraded {
			slog.Warn("preferences consolidation degraded", "actor", p.ActorID, "err", result.LastError)
		}
		prefsDiffResult = result
		prefsDiff = store.DiffApplyOpts{
			ActorID: p.ActorID, Dimension: "preferences", Namespace: fmt.Sprintf("/preferences/%s/", p.ActorID),
			SourceEventID: p.EventID, TTLDays: ttlFor("preferences"),
			PromoteAtReinforced: promoteAtReinforced,
		}
	}

	// Pre-compute embeddings for diff items BEFORE opening the tx, batched
	// into a single Embed call across all four dimensions. Inline failures
	// are logged and ignored — the backfill job recovers them.
	if !h.EmbedDisabled && h.Embed != nil {
		h.embedDiffs(ctx,
			&projectDiffResult.Diff,
			&taskDiffResult.Diff,
			&aboutDiffResult.Diff,
			&prefsDiffResult.Diff,
		)
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Idempotency: wipe prior append-dim writes for this event before re-inserting.
	if err := h.Store.DeleteAppendItemsForEvent(ctx, tx, p.EventID,
		[]string{"episodes", "daily_log"}); err != nil {
		return err
	}

	if hasProject {
		if err := h.Store.ApplyMemoryDiff(ctx, tx, projectDiff, projectDiffResult.Diff); err != nil {
			return fmt.Errorf("apply project diff: %w", err)
		}
	}

	if hasTask {
		if err := h.Store.ApplyMemoryDiff(ctx, tx, taskDiff, taskDiffResult.Diff); err != nil {
			return fmt.Errorf("apply task diff: %w", err)
		}
	}

	if hasAbout {
		if err := h.Store.ApplyMemoryDiff(ctx, tx, aboutDiff, aboutDiffResult.Diff); err != nil {
			return fmt.Errorf("apply about diff: %w", err)
		}
	}

	if hasPreferences {
		if err := h.Store.ApplyMemoryDiff(ctx, tx, prefsDiff, prefsDiffResult.Diff); err != nil {
			return fmt.Errorf("apply preferences diff: %w", err)
		}
	}

	if hasDaily {
		dailyNs := fmt.Sprintf("/daily/%s/%s/log/", p.ActorID, date)
		dailyTTL := ttlFor("daily_log")
		var expiresAt sql.NullTime
		if dailyTTL > 0 {
			expiresAt = sql.NullTime{
				Time:  time.Now().UTC().Add(time.Duration(dailyTTL) * 24 * time.Hour),
				Valid: true,
			}
		}
		var dailyEmbed []float32
		if !h.EmbedDisabled && h.Embed != nil {
			if er, err2 := h.Embed.Embed(ctx, embed.EmbedRequest{Texts: []string{ptl.Daily}}); err2 == nil {
				dailyEmbed = er.Vectors[0]
			} else {
				slog.Warn("embed daily_log inline failed; backfill will retry", "err", err2)
			}
		}
		if _, err := h.Store.InsertItem(ctx, tx, store.ItemInput{
			ActorID:       p.ActorID,
			Dimension:     "daily_log",
			Namespace:     dailyNs,
			Content:       ptl.Daily,
			Tags:          []string{},
			SourceEventID: p.EventID,
			ExpiresAt:     expiresAt,
			Embedding:     dailyEmbed,
		}); err != nil {
			return err
		}
	}

	if episodesEnabled {
		var episodesNamespace string
		switch actor.EpisodeStrategy {
		case "monthly_bucket":
			month := createdAt.UTC().Format("2006-01")
			episodesNamespace = fmt.Sprintf("/episodes/%s/%s/", p.ActorID, month)
		case "flat":
			fallthrough
		default:
			episodesNamespace = fmt.Sprintf("/episodes/%s/", p.ActorID)
		}
		epTTL := ttlFor("episodes")

		// Batch-embed all episode texts before the insert loop.
		var epTexts []string
		for _, e := range ep.Episodes {
			epTexts = append(epTexts, "Event: "+e.Event+"\nReflection: "+e.Reflection)
		}
		epEmbeddings := make([][]float32, len(epTexts))
		if !h.EmbedDisabled && h.Embed != nil && len(epTexts) > 0 {
			if er, err2 := h.Embed.Embed(ctx, embed.EmbedRequest{Texts: epTexts}); err2 == nil {
				epEmbeddings = er.Vectors
			} else {
				slog.Warn("embed episodes inline failed; backfill will retry", "err", err2)
			}
		}

		for i, e := range ep.Episodes {
			text := epTexts[i]
			var expiresAt sql.NullTime
			if epTTL > 0 {
				expiresAt = sql.NullTime{
					Time:  time.Now().UTC().Add(time.Duration(epTTL) * 24 * time.Hour),
					Valid: true,
				}
			}
			if _, err := h.Store.InsertItem(ctx, tx, store.ItemInput{
				ActorID:       p.ActorID,
				Dimension:     "episodes",
				Namespace:     episodesNamespace,
				Content:       text,
				Tags:          []string{},
				SourceEventID: p.EventID,
				ExpiresAt:     expiresAt,
				Embedding:     epEmbeddings[i],
			}); err != nil {
				return err
			}
			_ = e
		}
	}

	return tx.Commit()
}

// existingItemRefs loads existing items for a namespace and converts them to
// ItemRef values for the consolidation LLM call. The result is capped at
// maxConsolidationItems, ordered so the most-canonical (reinforced) and most-
// recently-updated items survive the cut.
func (h *Handler) existingItemRefs(ctx context.Context, actorID, namespace string) ([]ItemRef, error) {
	mems, err := h.Store.ListNamespaceForConsolidation(ctx, actorID, namespace, maxConsolidationItems)
	if err != nil {
		return nil, err
	}
	if len(mems) == maxConsolidationItems {
		slog.Warn("consolidation context capped",
			"actor", actorID, "namespace", namespace, "cap", maxConsolidationItems)
	}
	refs := make([]ItemRef, len(mems))
	for i, m := range mems {
		lastReinforced := m.UpdatedAt.UTC().Format("2006-01-02")
		refs[i] = ItemRef{
			ID:              m.ID,
			Content:         m.Content,
			Tags:            m.Tags,
			CreatedAt:       m.CreatedAt.UTC().Format("2006-01-02"),
			LastReinforced:  lastReinforced,
			ReinforcedCount: m.ReinforcedCount,
		}
	}
	return refs, nil
}

// embedDiffs pre-computes embeddings for all Insert and Update ops across
// every passed diff in a single Embed call. On failure it logs and leaves
// embeddings nil; the backfill job recovers them. Order is preserved:
// inserts first, then updates, per diff in the argument order.
func (h *Handler) embedDiffs(ctx context.Context, diffs ...*store.MemoryDiff) {
	var texts []string
	for _, d := range diffs {
		for _, op := range d.Insert {
			texts = append(texts, op.Content)
		}
		for _, op := range d.Update {
			texts = append(texts, op.Content)
		}
	}
	if len(texts) == 0 {
		return
	}
	resp, err := h.Embed.Embed(ctx, embed.EmbedRequest{Texts: texts})
	if err != nil {
		slog.Warn("embed diff inline failed; backfill will retry", "err", err, "n", len(texts))
		return
	}
	i := 0
	for _, d := range diffs {
		for j := range d.Insert {
			if i < len(resp.Vectors) {
				d.Insert[j].Embedding = resp.Vectors[i]
			}
			i++
		}
		for j := range d.Update {
			if i < len(resp.Vectors) {
				d.Update[j].Embedding = resp.Vectors[i]
			}
			i++
		}
	}
}

func turnsToText(raw json.RawMessage) string {
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err != nil {
		return string(raw)
	}
	var b strings.Builder
	for _, t := range arr {
		role, _ := t["role"].(string)
		content, _ := t["content"].(string)
		fmt.Fprintf(&b, "[%s]\n%s\n\n", role, content)
	}
	return b.String()
}

// userTurnsToText renders ONLY the user-role turns, with no role labels.
// The about extractor uses this instead of the full transcript: biographical
// facts are first-person testimony, but a coding session is ~80% assistant
// and tool turns. Feeding those to the bio extractor made the model mine
// assistant narration ("Let me inspect..."), tool output, and markdown
// fragments as "facts about the actor", polluting the about dimension. Any
// grounding material the actor pasted (a resume, a bio) is in their own user
// turn, so nothing real is lost by dropping the other roles. The "[user]"
// label is also omitted — it was itself extracted as a bogus identity line.
func userTurnsToText(raw json.RawMessage) string {
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err != nil {
		return ""
	}
	var b strings.Builder
	for _, t := range arr {
		if role, _ := t["role"].(string); role != "user" {
			continue
		}
		content, _ := t["content"].(string)
		fmt.Fprintf(&b, "%s\n\n", content)
	}
	return strings.TrimSpace(b.String())
}

func buildDomainList(domains []string) string {
	var b strings.Builder
	for _, d := range domains {
		fmt.Fprintf(&b, "   - %s\n", d)
	}
	return strings.TrimRight(b.String(), "\n")
}

func buildMetaSection(project, workdir string) string {
	if project == "" && workdir == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString("\nKNOWN CONTEXT:\n")
	if project != "" {
		fmt.Fprintf(&b, "Project: %s\n", project)
	}
	if workdir != "" {
		fmt.Fprintf(&b, "Working directory: %s\n", workdir)
	}
	return b.String()
}
