package queue

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/pgvector/pgvector-go"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

const BackfillBatchSize = 50

// BackfillEmbeddingsHandler reads rows where embedding IS NULL, embeds their
// content in batches of BackfillBatchSize, and writes the result. The job
// payload is ignored — the handler just picks up whatever NULL rows exist.
type BackfillEmbeddingsHandler struct {
	Store  *store.Store
	Embed  embed.Client
	Logger *slog.Logger
}

func (h *BackfillEmbeddingsHandler) Handle(ctx context.Context, _ json.RawMessage) error {
	rows, err := h.Store.DB.QueryContext(ctx, `
		SELECT memory_id, content
		  FROM memories
		 WHERE embedding IS NULL
		 LIMIT $1
	`, BackfillBatchSize)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()

	type pending struct {
		ID      string
		Content string
	}
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.ID, &p.Content); err != nil {
			return err
		}
		batch = append(batch, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(batch) == 0 {
		return nil
	}

	texts := make([]string, len(batch))
	for i, p := range batch {
		texts[i] = p.Content
	}
	resp, err := h.Embed.Embed(ctx, embed.EmbedRequest{Texts: texts})
	if err != nil {
		return err
	}

	// Write back the embeddings.
	for i, p := range batch {
		v := resp.Vectors[i]
		if len(v) == 0 {
			continue
		}
		_, err := h.Store.DB.ExecContext(ctx,
			`UPDATE memories SET embedding = $1 WHERE memory_id = $2`,
			pgvector.NewVector(v), p.ID,
		)
		if err != nil {
			h.Logger.Warn("backfill update", "id", p.ID, "err", err)
		}
	}
	h.Logger.Info("backfill", "embedded", len(batch), "tokens", resp.TokensUsed)
	return nil
}
