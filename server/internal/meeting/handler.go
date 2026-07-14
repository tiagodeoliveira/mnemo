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
	defer func() { _ = rows.Close() }()

	var transcript strings.Builder
	eventCount := 0
	for rows.Next() {
		var turnsRaw json.RawMessage
		if err := rows.Scan(&turnsRaw); err != nil {
			return err
		}
		eventCount++
		var arr []map[string]any
		if err := json.Unmarshal(turnsRaw, &arr); err != nil {
			continue
		}
		for _, t := range arr {
			// Each turn's content already carries its "[Speaker N]" label, so we
			// emit it as-is. Prefixing the wire role ("user") here would produce
			// confusing "[user] [Speaker N] ..." lines and contradict the prompt.
			content, _ := t["content"].(string)
			fmt.Fprintf(&transcript, "%s\n", content)
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
		MaxTokens: llm.LongFormMaxTokens,
	})
	if err != nil {
		return err
	}
	if out.StopReason == "max_tokens" {
		return &MeetingSummaryTruncatedError{MeetingID: p.MeetingID}
	}

	summary, err := ParseMeetingSummary(out.Text)
	if err != nil {
		return fmt.Errorf("parse meeting output: %w", err)
	}

	// Embed the single summary body before the tx.
	var embedding []float32
	if !h.EmbedDisabled && h.Embed != nil {
		if er, err2 := h.Embed.Embed(ctx, embed.EmbedRequest{Texts: []string{summary}}); err2 == nil && len(er.Vectors) > 0 {
			embedding = er.Vectors[0]
		} else if err2 != nil {
			slog.Warn("embed meeting summary inline failed; backfill will retry", "err", err2)
		}
	}

	summaryNS := fmt.Sprintf("/meetings/%s/%s/summary/", p.ActorID, p.MeetingID)

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := h.Store.ReplaceItemByNamespace(ctx, tx, store.ItemInput{
		ActorID:   p.ActorID,
		Dimension: "meeting",
		Namespace: summaryNS,
		Content:   summary,
		Embedding: embedding,
	}); err != nil {
		return err
	}
	// Sweep any legacy per-category rows from an older finalize of this meeting
	// (decisions/actions/questions/highlights/followups) so the meeting is
	// represented by exactly one durable memory.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM memories
		  WHERE actor_id=$1 AND dimension='meeting'
		    AND namespace LIKE $2 AND namespace <> $3`,
		p.ActorID, fmt.Sprintf("/meetings/%s/%s/%%", p.ActorID, p.MeetingID), summaryNS,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	slog.Info("meeting finalized",
		"actor", p.ActorID,
		"meeting_id", p.MeetingID,
		"events", eventCount,
		"transcript_bytes", transcript.Len(),
		"summary_bytes", len(summary))
	return nil
}

func sanitizeMeetingID(id string) string {
	id = strings.ReplaceAll(id, "\n", " ")
	id = strings.ReplaceAll(id, "\r", " ")
	if len(id) > 200 {
		id = id[:200]
	}
	return id
}
