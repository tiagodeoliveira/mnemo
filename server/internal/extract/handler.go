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

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// defaultTTLDays maps dimension name to TTL in days. 0 = never expires.
var defaultTTLDays = map[string]int{
	"preferences":   365,
	"about":         0,
	"project":       0,
	"task":          365,
	"daily_log":     365,
	"episodes":      0,
	"daily_summary": 365,
	"meeting":       0,
}

type Handler struct {
	Store *store.Store
	LLM   llm.Client
	Model string
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

	classifierPrompt := fmt.Sprintf(
		SystemExtractClassifier,
		buildMetaSection(projectName, workdir.String),
		buildDomainList(),
	) + "\n\nCONVERSATION:\n" + turnsText

	aboutPrompt := SystemExtractAbout + "\n\nCONVERSATION:\n" + turnsText

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
		ptl, err = ParseProjectTaskLog(out.Text)
		return err
	})

	var aboutItems []NewItem
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

	var prefs PreferencesOutput
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model:     h.Model,
			System:    SystemExtractPreferences,
			Messages:  []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 512,
		})
		if err != nil {
			return err
		}
		prefs, err = ParsePreferences(out.Text)
		return err
	})

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
			return err
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	// Build NewItem slices per dimension.
	var projectItems []NewItem
	if projectName != "" && !isNone(ptl.Facts) && ptl.Facts != "" {
		for _, line := range strings.Split(ptl.Facts, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || isNone(line) {
				continue
			}
			projectItems = append(projectItems, NewItem{Content: line, Tags: []string{"architecture"}})
		}
	}

	var taskItems []NewItem
	if ptl.TaskDomain != "unknown" && !isNone(ptl.Facts) && ptl.Facts != "" {
		for _, line := range strings.Split(ptl.Facts, "\n") {
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
		projectDiff store.DiffApplyOpts
		projectDiffResult ConsolidateResult
		taskDiff store.DiffApplyOpts
		taskDiffResult ConsolidateResult
		aboutDiff store.DiffApplyOpts
		aboutDiffResult ConsolidateResult
		prefsDiff store.DiffApplyOpts
		prefsDiffResult ConsolidateResult
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
		}
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

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
		if _, err := h.Store.InsertItem(ctx, tx, store.ItemInput{
			ActorID:       p.ActorID,
			Dimension:     "daily_log",
			Namespace:     dailyNs,
			Content:       ptl.Daily,
			Tags:          []string{},
			SourceEventID: p.EventID,
			ExpiresAt:     expiresAt,
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
		for _, e := range ep.Episodes {
			text := "Event: " + e.Event + "\nReflection: " + e.Reflection
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
			}); err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

// existingItemRefs loads existing items for a namespace and converts them to
// ItemRef values for the consolidation LLM call.
func (h *Handler) existingItemRefs(ctx context.Context, actorID, namespace string) ([]ItemRef, error) {
	mems, err := h.Store.ListItemsByNamespace(ctx, actorID, namespace)
	if err != nil {
		return nil, err
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

func buildDomainList() string {
	var b strings.Builder
	for _, d := range AllowedDomains {
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
