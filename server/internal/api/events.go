package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type eventRequest struct {
	SessionID   string          `json:"session_id"`
	Project     string          `json:"project"`
	Source      string          `json:"source"`
	Workstation string          `json:"workstation"`
	Workdir     string          `json:"workdir"`
	Turns       json.RawMessage `json:"turns"`
	Attributes  json.RawMessage `json:"attributes"`
}

type eventResponse struct {
	EventID string `json:"event_id"`
}

type eventsHandler struct {
	store  *store.Store
	logger *slog.Logger
}

func (h *eventsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req eventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.SessionID == "" {
		http.Error(w, "session_id required", http.StatusBadRequest)
		return
	}
	if len(req.Turns) == 0 {
		http.Error(w, "turns required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	actorID := auth.ActorID(ctx)

	tx, err := h.store.DB.BeginTx(ctx, nil)
	if err != nil {
		http.Error(w, "db", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	rec, err := h.store.InsertEvent(ctx, tx, store.EventInput{
		ActorID: actorID, SessionID: req.SessionID, Project: req.Project,
		Source: req.Source, Workstation: req.Workstation, Workdir: req.Workdir,
		Turns: req.Turns, Attributes: req.Attributes,
	})
	if err != nil {
		var bad *jsonObjectError
		if errors.As(err, &bad) || errors.Is(err, errBadTurns) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		h.logger.Error("insert event", "err", err)
		http.Error(w, "insert", http.StatusInternalServerError)
		return
	}

	if err := h.store.EnqueueJob(ctx, tx, store.KindExtractContext, map[string]any{
		"actor_id": actorID, "event_id": rec.EventID,
	}); err != nil {
		h.logger.Error("enqueue extract", "err", err)
		http.Error(w, "enqueue", http.StatusInternalServerError)
		return
	}
	if rec.MeetingEnded && rec.MeetingID.Valid {
		if err := h.store.EnqueueJob(ctx, tx, store.KindFinalizeMeeting, map[string]any{
			"actor_id": actorID, "meeting_id": rec.MeetingID.String,
		}); err != nil {
			h.logger.Error("enqueue finalize", "err", err)
			http.Error(w, "enqueue", http.StatusInternalServerError)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, "commit", http.StatusInternalServerError)
		return
	}

	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(eventResponse{EventID: rec.EventID.String()})
	_ = context.Background()
}

// Sentinel errors used by the handler for typed mapping.
type jsonObjectError struct{ msg string }

func (e *jsonObjectError) Error() string { return e.msg }

var errBadTurns = errors.New("turns must be a JSON array")
