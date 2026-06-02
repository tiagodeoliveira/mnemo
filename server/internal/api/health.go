package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

type pinger interface {
	PingContext(ctx context.Context) error
}

type healthHandler struct {
	db     pinger
	logger *slog.Logger
}

func (h *healthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	dbOK := h.db.PingContext(ctx) == nil
	w.Header().Set("content-type", "application/json")
	if !dbOK {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"db": dbOK})
}
