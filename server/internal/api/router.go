package api

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Deps struct {
	Store  *store.Store
	Logger *slog.Logger
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", (&healthHandler{db: d.Store.DB, logger: d.Logger}).ServeHTTP)
	return r
}
