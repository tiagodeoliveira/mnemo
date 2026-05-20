package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
	"golang.org/x/time/rate"
)

type Deps struct {
	Store         *store.Store
	Logger        *slog.Logger
	AuthVerifier  *auth.Verifier // nil ⇒ dev bypass
	DevActorID    string         // used when AuthVerifier == nil
	EmbedClient   embed.Client
	EmbedDisabled bool
}

// maxRequestBody is the ceiling for POST payloads (events, search).
// Generous enough for large turn arrays, small enough to reject abuse.
const maxRequestBody int64 = 1 << 20 // 1 MiB

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", (&healthHandler{db: d.Store.DB, logger: d.Logger}).ServeHTTP)

	resolver := func(ctx context.Context, id string) error {
		_, err := d.Store.UpsertActor(ctx, id)
		return err
	}
	authMW := auth.Middleware(d.AuthVerifier, resolver, d.DevActorID)
	rl := newIPRateLimiter(rate.Limit(10), 30) // 10 req/s steady, 30 burst
	r.Group(func(r chi.Router) {
		r.Use(authMW)
		r.Use(rateLimitMiddleware(rl))
		r.Use(limitBodyMiddleware(maxRequestBody))
		r.Post("/events", (&eventsHandler{store: d.Store, logger: d.Logger}).ServeHTTP)
		r.Get("/recall", (&recallHandler{store: d.Store, embedClient: d.EmbedClient, embedDisabled: d.EmbedDisabled, logger: d.Logger}).ServeHTTP)
		r.Post("/search", (&searchHandler{store: d.Store, embedClient: d.EmbedClient, embedDisabled: d.EmbedDisabled, logger: d.Logger}).ServeHTTP)
	})
	return r
}

// ── Per-IP rate limiter ────────────────────────────────────────────────

type ipRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
	rate     rate.Limit
	burst    int
}

func newIPRateLimiter(r rate.Limit, burst int) *ipRateLimiter {
	return &ipRateLimiter{limiters: make(map[string]*rate.Limiter), rate: r, burst: burst}
}

func (l *ipRateLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	if lim, ok := l.limiters[ip]; ok {
		return lim
	}
	lim := rate.NewLimiter(l.rate, l.burst)
	l.limiters[ip] = lim
	return lim
}

// Sweep removes stale entries. Called inline under lock — cheap because the
// map is keyed by IP (not request) and production traffic comes from a small
// set of IPs. A time-based eviction would add complexity for negligible gain.
func (l *ipRateLimiter) sweep(maxAge time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for ip, lim := range l.limiters {
		// A full bucket means no request has been seen recently.
		if lim.Tokens() >= float64(l.burst) {
			_ = now       // suppress unused
			_ = maxAge    // placeholder for future TTL eviction
			delete(l.limiters, ip)
		}
	}
}

func rateLimitMiddleware(rl *ipRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
				ip = fwd
			}
			if !rl.get(ip).Allow() {
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func limitBodyMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil && r.ContentLength != 0 {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}
