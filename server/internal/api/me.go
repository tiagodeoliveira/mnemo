package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// meResponse is the JSON shape returned by GET /me and PATCH /me.
type meResponse struct {
	ActorID         string   `json:"actor_id"`
	DisplayName     string   `json:"display_name"`
	Email           string   `json:"email,omitempty"`
	Timezone        string   `json:"timezone"`
	DigestEnabled   bool     `json:"digest_enabled"`
	EpisodeStrategy string   `json:"episode_strategy"`
	TaskDomains     []string `json:"task_domains"`
}

func actorToResponse(a *store.Actor) meResponse {
	resp := meResponse{
		ActorID:         a.ID,
		DisplayName:     a.DisplayName,
		Timezone:        a.Timezone,
		DigestEnabled:   a.DigestEnabled,
		EpisodeStrategy: a.EpisodeStrategy,
		TaskDomains:     a.TaskDomains,
	}
	if a.Email.Valid {
		resp.Email = a.Email.String
	}
	return resp
}

// mePatchRequest is the JSON body accepted by PATCH /me.
// All fields are pointers so we can distinguish "not provided" from zero values.
type mePatchRequest struct {
	Email         *string   `json:"email"`
	Timezone      *string   `json:"timezone"`
	DigestEnabled *bool     `json:"digest_enabled"`
	TaskDomains   *[]string `json:"task_domains"`
}

// domainSlugRE matches the canonical task-domain shape: lowercase ascii letters,
// digits, dashes. Must start and end with a letter/digit.
var domainSlugRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

// validateTaskDomains enforces the four invariants the rest of the system
// depends on: 'general' must be present, no empties, no duplicates, kebab-case
// slugs only. Returns the canonicalized list (deduped, ordered) on success.
func validateTaskDomains(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	hasGeneral := false
	for _, raw := range in {
		s := strings.ToLower(strings.TrimSpace(raw))
		if s == "" {
			return nil, fmt.Errorf("task domain cannot be empty")
		}
		if !domainSlugRE.MatchString(s) {
			return nil, fmt.Errorf("invalid task domain %q: use lowercase letters, digits, dashes", raw)
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		if s == "general" {
			hasGeneral = true
		}
		out = append(out, s)
	}
	if !hasGeneral {
		return nil, fmt.Errorf("task_domains must include 'general'")
	}
	return out, nil
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
	if req.Email == nil && req.Timezone == nil && req.DigestEnabled == nil && req.TaskDomains == nil {
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

	// Validate and canonicalize task domains.
	var canonDomains *[]string
	if req.TaskDomains != nil {
		v, err := validateTaskDomains(*req.TaskDomains)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		canonDomains = &v
	}

	actorID := auth.ActorID(r.Context())
	updated, err := h.store.UpdateActorProfile(r.Context(), actorID, store.ActorProfileUpdate{
		Email:         req.Email,
		Timezone:      req.Timezone,
		DigestEnabled: req.DigestEnabled,
		TaskDomains:   canonDomains,
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
