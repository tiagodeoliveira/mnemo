package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// bootstrapTargetChunkSize is the soft cap on each synthesized event's body.
// Chunks pack paragraphs until exceeding this; a single oversized paragraph
// gets its own chunk regardless.
const bootstrapTargetChunkSize = 3000

// bootstrapMaxContent is the upper bound on a single POST /bootstrap body's
// content field. Larger documents should be split client-side and posted in
// multiple calls (each chunk is independent — splitting earlier costs nothing).
const bootstrapMaxContent = 256 * 1024 // 256 KiB

type bootstrapRequest struct {
	Source  string `json:"source"`  // freeform label: "README.md", "main.go", etc.
	Project string `json:"project"` // optional; if set, routes into project namespace
	Content string `json:"content"` // the document body
}

type bootstrapResponse struct {
	EventIDs   []string `json:"event_ids"`
	ChunkCount int      `json:"chunk_count"`
}

type bootstrapHandler struct {
	store  *store.Store
	logger *slog.Logger
}

func (h *bootstrapHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req bootstrapRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		http.Error(w, "content required", http.StatusBadRequest)
		return
	}
	if len(req.Content) > bootstrapMaxContent {
		http.Error(w, fmt.Sprintf("content exceeds %d bytes; split client-side", bootstrapMaxContent),
			http.StatusBadRequest)
		return
	}
	if req.Source == "" {
		req.Source = "bootstrap"
	}

	chunks := chunkDocument(req.Content, bootstrapTargetChunkSize)
	if len(chunks) == 0 {
		http.Error(w, "no chunks produced from content", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	actorID := auth.ActorID(ctx)

	// Single tx so the whole document is all-or-nothing. A partial bootstrap
	// leaves the memory in an awkward "we extracted half your README" state;
	// atomic ingest avoids that.
	tx, err := h.store.DB.BeginTx(ctx, nil)
	if err != nil {
		http.Error(w, "db", http.StatusInternalServerError)
		return
	}
	defer func() { _ = tx.Rollback() }()

	sessionID := fmt.Sprintf("bootstrap-%s-%s", req.Source, uuid.New().String())
	eventIDs := make([]string, 0, len(chunks))

	for i, chunk := range chunks {
		turns, _ := json.Marshal([]map[string]string{
			{"role": "user", "content": chunk},
		})
		attrs, _ := json.Marshal(map[string]any{
			"bootstrap_source": req.Source,
			"bootstrap_chunk":  i + 1,
			"bootstrap_total":  len(chunks),
		})

		rec, err := h.store.InsertEvent(ctx, tx, store.EventInput{
			ActorID:    actorID,
			SessionID:  sessionID,
			Project:    req.Project,
			Source:     "bootstrap",
			Workdir:    "",
			Turns:      turns,
			Attributes: attrs,
		})
		if err != nil {
			h.logger.Error("bootstrap insert event", "err", err, "chunk", i)
			http.Error(w, "insert", http.StatusInternalServerError)
			return
		}
		if err := h.store.EnqueueJob(ctx, tx, store.KindExtractContext, map[string]any{
			"actor_id": actorID,
			"event_id": rec.EventID,
		}); err != nil {
			h.logger.Error("bootstrap enqueue", "err", err, "chunk", i)
			http.Error(w, "enqueue", http.StatusInternalServerError)
			return
		}
		eventIDs = append(eventIDs, rec.EventID.String())
	}

	if err := tx.Commit(); err != nil {
		http.Error(w, "commit", http.StatusInternalServerError)
		return
	}

	h.logger.Info("bootstrap ingested",
		"source", req.Source, "project", req.Project, "chunks", len(chunks))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(bootstrapResponse{
		EventIDs:   eventIDs,
		ChunkCount: len(chunks),
	})
}

// chunkDocument splits content on paragraph boundaries (double newline) and
// packs paragraphs into chunks until each reaches roughly targetSize bytes.
// A single paragraph larger than targetSize gets its own chunk — we never
// split mid-paragraph because that would hand the extractor incoherent
// half-sentences and degrade classification quality.
func chunkDocument(content string, targetSize int) []string {
	if targetSize <= 0 {
		targetSize = bootstrapTargetChunkSize
	}
	paragraphs := strings.Split(content, "\n\n")
	var chunks []string
	var current strings.Builder
	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if current.Len() > 0 && current.Len()+len(p)+2 > targetSize {
			chunks = append(chunks, current.String())
			current.Reset()
		}
		if current.Len() > 0 {
			current.WriteString("\n\n")
		}
		current.WriteString(p)
	}
	if current.Len() > 0 {
		chunks = append(chunks, current.String())
	}
	return chunks
}

