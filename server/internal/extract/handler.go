package extract

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

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

	turnsText := turnsToText(turnsRaw)
	projectName := project.String
	date := createdAt.UTC().Format("2006-01-02")

	classifierPrompt := fmt.Sprintf(
		SystemProjectTaskDailyLog,
		buildMetaSection(projectName, workdir.String),
		buildDomainList(),
	) + "\n\nCONVERSATION:\n" + turnsText

	aboutPrompt := SystemAbout + "\n\nCONVERSATION:\n" + turnsText

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

	var aboutText string
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model:     h.Model,
			Messages:  []llm.Message{{Role: "user", Content: aboutPrompt}},
			MaxTokens: 1024,
		})
		if err != nil {
			return err
		}
		aboutText = strings.TrimSpace(out.Text)
		return nil
	})

	var prefs PreferencesOutput
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model:     h.Model,
			System:    SystemPreferences,
			Messages:  []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 512,
		})
		if err != nil {
			return err
		}
		prefs, err = ParsePreferences(out.Text)
		return err
	})

	var fx FactsEpisodesOutput
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model:     h.Model,
			System:    SystemFactsEpisodes,
			Messages:  []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 768,
		})
		if err != nil {
			return err
		}
		fx, err = ParseFactsEpisodes(out.Text)
		return err
	})

	if err := g.Wait(); err != nil {
		return err
	}

	hasProject := projectName != "" && !isNone(ptl.Facts)
	hasTask := ptl.TaskDomain != "unknown" && !isNone(ptl.Facts)
	hasDaily := !isNone(ptl.Daily)
	hasAbout := !isNone(aboutText)

	// Consolidation LLM calls happen OUTSIDE the tx (they can take seconds).
	// We accept the cost of re-running them on retry.

	var (
		consolidatedProject string
		consolidatedTask    string
		consolidatedAbout   string
	)

	if hasProject {
		ns := fmt.Sprintf("/projects/%s/%s/", p.ActorID, projectName)
		prior, err := h.readPrior(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		if len(prior) > 0 {
			merged, err := Consolidate(ctx, h.LLM, h.Model, DimProject, prior, ptl.Facts, projectName)
			if err != nil {
				return err
			}
			consolidatedProject = merged
		} else {
			consolidatedProject = ptl.Facts
		}
	}

	if hasTask {
		ns := fmt.Sprintf("/tasks/%s/%s/", p.ActorID, ptl.TaskDomain)
		prior, err := h.readPrior(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		if len(prior) > 0 {
			merged, err := Consolidate(ctx, h.LLM, h.Model, DimTask, prior, ptl.Facts, "")
			if err != nil {
				return err
			}
			consolidatedTask = merged
		} else {
			consolidatedTask = ptl.Facts
		}
	}

	if hasAbout {
		ns := fmt.Sprintf("/about/%s/", p.ActorID)
		prior, err := h.readPrior(ctx, p.ActorID, ns)
		if err != nil {
			return err
		}
		// About ALWAYS consolidates, even on first write — narrative shape.
		merged, err := Consolidate(ctx, h.LLM, h.Model, DimAbout, prior, aboutText, "")
		if err != nil {
			var ct *ConsolidationTruncatedError
			if errors.As(err, &ct) {
				return err
			}
			return err
		}
		consolidatedAbout = merged
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Idempotency: wipe prior append-dim writes for this event before re-inserting.
	if err := h.Store.DeleteAppendMemoriesForEvent(ctx, tx, p.ActorID, p.EventID,
		[]string{"preferences", "facts", "episodes", "daily_log"}); err != nil {
		return err
	}

	if hasProject {
		ns := fmt.Sprintf("/projects/%s/%s/", p.ActorID, projectName)
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "project", Namespace: ns,
			Content:       TruncateToLimit(consolidatedProject),
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	if hasTask {
		ns := fmt.Sprintf("/tasks/%s/%s/", p.ActorID, ptl.TaskDomain)
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "task", Namespace: ns,
			Content:       TruncateToLimit(consolidatedTask),
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	if hasAbout {
		ns := fmt.Sprintf("/about/%s/", p.ActorID)
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "about", Namespace: ns,
			Content:       TruncateToLimit(consolidatedAbout),
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	if hasDaily {
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "daily_log",
			Namespace:     fmt.Sprintf("/daily/%s/%s/log/", p.ActorID, date),
			Content:       ptl.Daily,
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	for _, pref := range prefs.Preferences {
		if strings.TrimSpace(pref) == "" {
			continue
		}
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "preferences",
			Namespace:     fmt.Sprintf("/preferences/%s/", p.ActorID),
			Content:       pref,
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	for _, f := range fx.Facts {
		if strings.TrimSpace(f) == "" {
			continue
		}
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "facts",
			Namespace:     fmt.Sprintf("/facts/%s/", p.ActorID),
			Content:       f,
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	for _, ep := range fx.Episodes {
		text := "Event: " + ep.Event + "\nReflection: " + ep.Reflection
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "episodes",
			Namespace:     fmt.Sprintf("/episodes/%s/", p.ActorID),
			Content:       text,
			SourceEventID: &p.EventID,
		}); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (h *Handler) readPrior(ctx context.Context, actor, namespace string) ([]string, error) {
	rows, err := h.Store.DB.QueryContext(ctx,
		`SELECT content FROM memories WHERE actor_id=$1 AND namespace=$2 ORDER BY updated_at DESC`,
		actor, namespace,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
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
