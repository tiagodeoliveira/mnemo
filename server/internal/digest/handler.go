package digest

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Handler struct {
	Store  *store.Store
	LLM    llm.Client
	Model  string
	Mailer *Mailer
}

type payload struct {
	ActorID string `json:"actor_id"`
	Date    string `json:"date"` // YYYY-MM-DD in actor's local TZ
}

func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) error {
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}

	// Collect daily_log entries for this actor/date.
	ns := fmt.Sprintf("/daily/%s/%s/log/", p.ActorID, p.Date)
	rows, err := h.Store.DB.QueryContext(ctx, `
		SELECT content FROM memories
		 WHERE actor_id=$1 AND dimension='daily_log' AND namespace=$2
		 ORDER BY created_at
	`, p.ActorID, ns)
	if err != nil {
		return err
	}
	var entries []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			_ = rows.Close()
			return err
		}
		entries = append(entries, c)
	}
	_ = rows.Close()
	if len(entries) == 0 {
		// Nothing to digest — no error, just skip.
		return nil
	}

	logsBlock := BuildLogsBlock(entries)
	prompt := fmt.Sprintf(SystemDailyDigest, p.Date, logsBlock)

	out, err := h.LLM.Complete(ctx, llm.CompleteRequest{
		Model:     h.Model,
		Messages:  []llm.Message{{Role: "user", Content: prompt}},
		MaxTokens: 8192,
	})
	if err != nil {
		return err
	}
	if out.StopReason == "max_tokens" {
		return &DigestTruncatedError{Date: p.Date}
	}
	digestText := strings.TrimSpace(out.Text)
	if digestText == "" {
		return fmt.Errorf("digest: empty output")
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
		ActorID:   p.ActorID,
		Dimension: "daily_summary",
		Namespace: fmt.Sprintf("/daily/%s/%s/summary/", p.ActorID, p.Date),
		Content:   digestText,
	}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	// Optional email — never fail the job because of a delivery error.
	if h.Mailer != nil && h.Mailer.Enabled() {
		var email sql.NullString
		if err := h.Store.DB.QueryRowContext(ctx,
			`SELECT email FROM actors WHERE actor_id=$1`, p.ActorID,
		).Scan(&email); err == nil && email.Valid && email.String != "" {
			_ = h.Mailer.Send(email.String, "mnemo daily digest "+p.Date, digestText)
		}
	}
	return nil
}
