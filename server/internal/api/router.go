package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Deps struct {
	Store        *store.Store
	Logger       *slog.Logger
	AuthVerifier *auth.Verifier // nil ⇒ dev bypass
	DevActorID   string         // used when AuthVerifier == nil
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", (&healthHandler{db: d.Store.DB, logger: d.Logger}).ServeHTTP)

	resolver := func(ctx context.Context, id string) error {
		_, err := d.Store.UpsertActor(ctx, id)
		return err
	}
	authMW := auth.Middleware(d.AuthVerifier, resolver, d.DevActorID)
	r.Group(func(r chi.Router) {
		r.Use(authMW)
		// /events and /recall registered here in later tasks.
	})
	return r
}
