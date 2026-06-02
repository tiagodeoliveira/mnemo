package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
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
		r.Handle("/me", &meHandler{store: d.Store, logger: d.Logger})
	})
	// Bootstrap path gets the same auth + rate limit but a larger body
	// allowance (full documents are 10–100 KB; chat turns are < 10 KB).
	r.Group(func(r chi.Router) {
		r.Use(authMW)
		r.Use(rateLimitMiddleware(rl))
		r.Use(limitBodyMiddleware(int64(bootstrapMaxContent + 4096)))
		r.Post("/bootstrap", (&bootstrapHandler{store: d.Store, logger: d.Logger}).ServeHTTP)
	})
	return r
}

// ── Per-IP rate limiter ────────────────────────────────────────────────

type ipEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type ipRateLimiter struct {
	mu      sync.Mutex
	entries map[string]*ipEntry
	rate    rate.Limit
	burst   int
	ttl     time.Duration
}

func newIPRateLimiter(r rate.Limit, burst int) *ipRateLimiter {
	rl := &ipRateLimiter{
		entries: make(map[string]*ipEntry),
		rate:    r,
		burst:   burst,
		ttl:     10 * time.Minute,
	}
	go rl.evictLoop()
	return rl
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[ip]
	if !ok {
		e = &ipEntry{limiter: rate.NewLimiter(l.rate, l.burst)}
		l.entries[ip] = e
	}
	e.lastSeen = time.Now()
	return e.limiter.Allow()
}

func (l *ipRateLimiter) evictLoop() {
	t := time.NewTicker(l.ttl)
	defer t.Stop()
	for range t.C {
		l.mu.Lock()
		cutoff := time.Now().Add(-l.ttl)
		for ip, e := range l.entries {
			if e.lastSeen.Before(cutoff) {
				delete(l.entries, ip)
			}
		}
		l.mu.Unlock()
	}
}

// clientIP extracts the client IP for rate-limiting purposes.
// X-Forwarded-For can be a comma-separated chain; we use the first
// (leftmost) entry, which is the original client IP as seen by the
// first proxy. We trim the port from RemoteAddr as a fallback.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i > 0 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	// RemoteAddr is "IP:port"; strip port.
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

func rateLimitMiddleware(rl *ipRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !rl.allow(clientIP(r)) {
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
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}
