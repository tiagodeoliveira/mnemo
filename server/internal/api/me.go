package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// meResponse is the JSON shape returned by GET /me and PATCH /me.
type meResponse struct {
	ActorID         string `json:"actor_id"`
	DisplayName     string `json:"display_name"`
	Email           string `json:"email,omitempty"`
	Timezone        string `json:"timezone"`
	DigestEnabled   bool   `json:"digest_enabled"`
	EpisodeStrategy string `json:"episode_strategy"`
}

func actorToResponse(a *store.Actor) meResponse {
	resp := meResponse{
		ActorID:         a.ID,
		DisplayName:     a.DisplayName,
		Timezone:        a.Timezone,
		DigestEnabled:   a.DigestEnabled,
		EpisodeStrategy: a.EpisodeStrategy,
	}
	if a.Email.Valid {
		resp.Email = a.Email.String
	}
	return resp
}

// mePatchRequest is the JSON body accepted by PATCH /me.
// All fields are pointers so we can distinguish "not provided" from zero values.
type mePatchRequest struct {
	Email         *string `json:"email"`
	Timezone      *string `json:"timezone"`
	DigestEnabled *bool   `json:"digest_enabled"`
}

type meHandler struct {
	store  *store.Store
	logger *slog.Logger
}

func (h *meHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodPatch:
		h.handlePatch(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *meHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	actorID := auth.ActorID(r.Context())
	actor, err := h.store.GetActor(r.Context(), actorID)
	if err != nil {
		h.logger.Error("me: get actor", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if actor == nil {
		http.Error(w, "actor not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(actorToResponse(actor))
}

func (h *meHandler) handlePatch(w http.ResponseWriter, r *http.Request) {
	var req mePatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate: at least one field must be provided.
	if req.Email == nil && req.Timezone == nil && req.DigestEnabled == nil {
		http.Error(w, "no fields to update", http.StatusBadRequest)
		return
	}

	// Validate timezone.
	if req.Timezone != nil {
		if _, err := time.LoadLocation(*req.Timezone); err != nil {
			http.Error(w, "invalid timezone: "+*req.Timezone, http.StatusBadRequest)
			return
		}
	}

	// Validate email.
	if req.Email != nil {
		if !strings.Contains(*req.Email, "@") {
			http.Error(w, "invalid email", http.StatusBadRequest)
			return
		}
	}

	actorID := auth.ActorID(r.Context())
	updated, err := h.store.UpdateActorProfile(r.Context(), actorID, store.ActorProfileUpdate{
		Email:         req.Email,
		Timezone:      req.Timezone,
		DigestEnabled: req.DigestEnabled,
	})
	if err != nil {
		h.logger.Error("me: update actor", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if updated == nil {
		http.Error(w, "actor not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(actorToResponse(updated))
}
