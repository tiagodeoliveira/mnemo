package meeting

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Handler struct {
	Store         *store.Store
	LLM           llm.Client
	Model         string
	Embed         embed.Client
	EmbedDisabled bool
}

type payload struct {
	ActorID   string `json:"actor_id"`
	MeetingID string `json:"meeting_id"`
}

func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) error {
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}

	// Pull all events for this meeting, ordered chronologically.
	rows, err := h.Store.DB.QueryContext(ctx,
		`SELECT turns FROM events WHERE actor_id=$1 AND meeting_id=$2 ORDER BY created_at`,
		p.ActorID, p.MeetingID,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	var transcript strings.Builder
	for rows.Next() {
		var turnsRaw json.RawMessage
		if err := rows.Scan(&turnsRaw); err != nil {
			return err
		}
		var arr []map[string]any
		if err := json.Unmarshal(turnsRaw, &arr); err != nil {
			continue
		}
		for _, t := range arr {
			role, _ := t["role"].(string)
			content, _ := t["content"].(string)
			fmt.Fprintf(&transcript, "[%s] %s\n", role, content)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if transcript.Len() == 0 {
		return fmt.Errorf("no events for meeting %s", p.MeetingID)
	}

	prompt := fmt.Sprintf(SystemMeetingSummary, sanitizeMeetingID(p.MeetingID), transcript.String())

	out, err := h.LLM.Complete(ctx, llm.CompleteRequest{
		Model:     h.Model,
		Messages:  []llm.Message{{Role: "user", Content: prompt}},
		MaxTokens: 8192,
	})
	if err != nil {
		return err
	}
	if out.StopReason == "max_tokens" {
		return &MeetingSummaryTruncatedError{MeetingID: p.MeetingID}
	}

	parsed, err := ParseMeetingSummary(out.Text)
	if err != nil {
		return fmt.Errorf("parse meeting output: %w", err)
	}

	// Collect non-empty category bodies.
	type catBody struct {
		cat  string
		body string
	}
	var catBodies []catBody
	for _, cat := range Categories {
		body := strings.TrimSpace(parsed[cat])
		if body != "" {
			catBodies = append(catBodies, catBody{cat, body})
		}
	}

	// Batch-embed all category bodies before the tx.
	catEmbeddings := make([][]float32, len(catBodies))
	if !h.EmbedDisabled && h.Embed != nil && len(catBodies) > 0 {
		texts := make([]string, len(catBodies))
		for i, cb := range catBodies {
			texts[i] = cb.body
		}
		if er, err2 := h.Embed.Embed(ctx, embed.EmbedRequest{Texts: texts}); err2 == nil {
			catEmbeddings = er.Vectors
		} else {
			slog.Warn("embed meeting categories inline failed; backfill will retry", "err", err2)
		}
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for i, cb := range catBodies {
		if err := h.Store.ReplaceItemByNamespace(ctx, tx, store.ItemInput{
			ActorID:   p.ActorID,
			Dimension: "meeting",
			Namespace: fmt.Sprintf("/meetings/%s/%s/%s/", p.ActorID, p.MeetingID, cb.cat),
			Content:   cb.body,
			Embedding: catEmbeddings[i],
		}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func sanitizeMeetingID(id string) string {
	id = strings.ReplaceAll(id, "\n", " ")
	id = strings.ReplaceAll(id, "\r", " ")
	if len(id) > 200 {
		id = id[:200]
	}
	return id
}
