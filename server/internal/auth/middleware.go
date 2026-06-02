package auth

import (
	"context"
	"net/http"
	"strings"
)

type ctxKey struct{}

type Resolver func(ctx context.Context, actorID string) error // upserts actor

// Middleware verifies the JWT and stashes the actor id on the request context.
// When verifier is nil (dev mode), every request maps to devActorID.
func Middleware(v *Verifier, resolver Resolver, devActorID string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var actorID string
			if v == nil {
				actorID = devActorID
			} else {
				h := r.Header.Get("Authorization")
				if !strings.HasPrefix(h, "Bearer ") {
					http.Error(w, "missing bearer", http.StatusUnauthorized)
					return
				}
				sub, err := v.Verify(strings.TrimPrefix(h, "Bearer "))
				if err != nil {
					http.Error(w, "invalid token", http.StatusUnauthorized)
					return
				}
				actorID = sub
			}
			if err := resolver(r.Context(), actorID); err != nil {
				http.Error(w, "actor resolve", http.StatusInternalServerError)
				return
			}
			ctx := context.WithValue(r.Context(), ctxKey{}, actorID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func ActorID(ctx context.Context) string {
	v, _ := ctx.Value(ctxKey{}).(string)
	return v
}
