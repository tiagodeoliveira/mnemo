package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/api"
	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/config"
	"github.com/tiagodeoliveira/mnemo/server/internal/digest"
	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/extract"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/meeting"
	"github.com/tiagodeoliveira/mnemo/server/internal/observability"
	"github.com/tiagodeoliveira/mnemo/server/internal/queue"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// Stamped at build time via -ldflags "-X main.version=… -X main.commit=…".
// Defaults are what an unstamped `go build` produces — useful for local dev.
var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	// Subcommands. The binary is the only thing inside the distroless
	// image — no shell, no wget/curl — so a `healthz` subcommand is
	// what makes a working container healthcheck possible. See the
	// Dockerfile's HEALTHCHECK and downstream compose probes.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthz":
			healthzExit()
		default:
			_, _ = os.Stderr.WriteString("unknown subcommand: " + os.Args[1] + "\n")
			os.Exit(2)
		}
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	// Route package-level slog calls (used in extract/store/digest/meeting
	// helpers that aren't given a logger) through the same JSON handler.
	slog.SetDefault(logger)
	logger.Info("mnemo-server starting",
		"version", version,
		"commit", commit,
		"go", runtime.Version(),
		"pid", os.Getpid())

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config", "err", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Wire OTel metrics so a downstream collector / Prometheus receives
	// target_info, http.server.request.duration, circuit_breaker_open,
	// worker_jobs_total, and the LLM metrics (llm_request_duration_seconds,
	// llm_tokens_used_total). The SDK reads OTEL_SERVICE_NAME and
	// OTEL_EXPORTER_OTLP_ENDPOINT from the environment.
	mp, err := observability.InitMetrics(ctx)
	if err != nil {
		// A misconfigured OTLP endpoint should not prevent the server from
		// starting — log and proceed. mp is nil; the global no-op
		// MeterProvider keeps every instrument call safe.
		logger.Warn("observability init failed; metrics disabled", "err", err)
	}
	breakerMetrics := observability.NewBreakerMetrics()
	workerMetrics := observability.NewWorkerMetrics()
	llmMetrics := observability.NewLLMMetrics()

	s, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("store.Open", "err", err)
		os.Exit(3)
	}
	defer func() { _ = s.Close() }()

	if err := s.Migrate(); err != nil {
		logger.Error("migrate", "err", err)
		os.Exit(4)
	}

	var verifier *auth.Verifier
	if !cfg.AuthDisabled {
		verifier, err = auth.NewVerifier(ctx, cfg.Auth0Domain, cfg.Auth0Audience)
		if err != nil {
			logger.Error("auth init", "err", err)
			os.Exit(6)
		}
	} else {
		logger.Warn("MNEMO_AUTH_DISABLED=1: bypass mode, every request maps to dev-actor")
	}

	// LLM client construction.
	var rawLlm llm.Client
	// primaryModel is the model handlers pass via CompleteRequest.Model. In the
	// single-provider case it's the only model. In chain mode the Chain swaps
	// it per provider, but we still seed it with the primary's so a chain-less
	// fallback would behave the same.
	var primaryModel string
	if cfg.LLMDisabled {
		rawLlm = &llm.Stub{}
		logger.Warn("MNEMO_LLM_DISABLED=1: using stub LLM")
	} else {
		providers, err := buildLLMProviders(cfg, llmMetrics)
		if err != nil {
			logger.Error("llm providers", "err", err)
			os.Exit(7)
		}
		primaryModel = providers[0].Model
		if len(providers) == 1 {
			rawLlm = providers[0].Client
			logger.Info("LLM provider", "name", providers[0].Name, "model", providers[0].Model)
		} else {
			cooldown := time.Duration(cfg.LLMBreakerCooldownS) * time.Second
			rawLlm = llm.NewChain(providers, cfg.LLMBreakerThreshold, cooldown, logger, breakerMetrics)
			names := make([]string, len(providers))
			for i, p := range providers {
				names[i] = p.Name
			}
			logger.Info("LLM provider chain",
				"order", names,
				"breaker_threshold", cfg.LLMBreakerThreshold,
				"breaker_cooldown", cooldown)
		}
	}
	// Wrap with concurrency throttle.
	llmClient := llm.NewThrottled(rawLlm, cfg.LLMMaxConcurrent)
	if cfg.LLMMaxConcurrent > 0 {
		logger.Info("LLM concurrency throttle", "max_concurrent", cfg.LLMMaxConcurrent)
	}

	// Embed client construction.
	var embedClient embed.Client
	if cfg.EmbedDisabled {
		embedClient = &embed.Stub{}
		logger.Warn("MNEMO_EMBED_DISABLED=1: using stub embeddings (search will return 503)")
	} else {
		embedClient = &embed.OpenAI{APIKey: cfg.OpenAIAPIKey, Model: cfg.EmbedModel}
	}

	extractHandler := &extract.Handler{
		Store: s, LLM: llmClient, Model: primaryModel,
		Embed: embedClient, EmbedDisabled: cfg.EmbedDisabled,
	}
	meetingHandler := &meeting.Handler{
		Store: s, LLM: llmClient, Model: primaryModel,
		Embed: embedClient, EmbedDisabled: cfg.EmbedDisabled,
	}
	mailer := &digest.Mailer{
		Host: cfg.SMTPHost,
		User: cfg.SMTPUser,
		Pass: cfg.SMTPPass,
		From: cfg.SMTPFrom,
	}
	digestHandler := &digest.Handler{
		Store: s, LLM: llmClient, Model: primaryModel, Mailer: mailer,
		Embed: embedClient, EmbedDisabled: cfg.EmbedDisabled,
	}
	backfillHandler := &queue.BackfillEmbeddingsHandler{
		Store: s, Embed: embedClient, Logger: logger,
	}

	handlers := map[store.JobKind]queue.Handler{
		store.KindExtractContext:     extractHandler.Handle,
		store.KindFinalizeMeeting:    meetingHandler.Handle,
		store.KindDailyDigest:        digestHandler.Handle,
		store.KindBackfillEmbeddings: backfillHandler.Handle,
	}
	// Reclaim any 'running' jobs left over from a previous server's crash.
	// Safe at boot because no worker can possibly hold a lock yet.
	if n, err := s.ReclaimStaleJobs(ctx); err != nil {
		logger.Warn("reclaim stale jobs failed", "err", err)
	} else if n > 0 {
		logger.Info("reclaimed stale running jobs from prior boot", "count", n)
	}

	registered := make([]string, 0, len(handlers))
	for k := range handlers {
		registered = append(registered, string(k))
	}
	logger.Info("worker pool starting",
		"workers", cfg.WorkerCount,
		"handlers", registered,
		"breaker_threshold", cfg.WorkerBreakerThreshold,
		"breaker_cooldown_s", cfg.WorkerBreakerCooldownS)
	pool := queue.NewPool(s, logger, handlers, queue.PoolConfig{
		Workers:          cfg.WorkerCount,
		BreakerThreshold: cfg.WorkerBreakerThreshold,
		BreakerCooldown:  time.Duration(cfg.WorkerBreakerCooldownS) * time.Second,
		BreakerMetrics:   breakerMetrics,
		WorkerMetrics:    workerMetrics,
	})
	poolDone := make(chan struct{})
	go func() { pool.Run(ctx); close(poolDone) }()

	// Digest scheduler — leader-only.
	go queue.RunAsLeader(ctx, s.DB, logger, "digest_scheduler", queue.LockKeyDigestScheduler, 30*time.Second, func(ctx context.Context) {
		sched := &digest.Scheduler{Store: s, Logger: logger, DigestHour: 19}
		sched.Run(ctx)
	})

	// Sweeper — leader-only.
	go queue.RunAsLeader(ctx, s.DB, logger, "sweeper", queue.LockKeySweeper, 30*time.Second, func(ctx context.Context) {
		queue.Sweeper(ctx, s, logger, 7*24*time.Hour, time.Hour)
	})

	// Memory expiry sweeper — leader-only. Enforces the reinforcement-decay TTL
	// by deleting rows past expires_at, hourly.
	go queue.RunAsLeader(ctx, s.DB, logger, "memory_expiry_sweeper", queue.LockKeyMemoryExpiry, 30*time.Second, func(ctx context.Context) {
		queue.MemoryExpirySweeper(ctx, s, logger, time.Hour)
	})

	// Backfill embeddings scheduler — leader-only.
	go queue.RunAsLeader(ctx, s.DB, logger, "backfill_scheduler", queue.LockKeyBackfillScheduler, 30*time.Second, func(ctx context.Context) {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				tx, err := s.DB.BeginTx(ctx, nil)
				if err != nil {
					logger.Warn("backfill scheduler: begin tx", "err", err)
					continue
				}
				if err := s.EnqueueJob(ctx, tx, store.KindBackfillEmbeddings, map[string]any{}); err != nil {
					_ = tx.Rollback()
					logger.Warn("backfill scheduler: enqueue", "err", err)
					continue
				}
				_ = tx.Commit()
			}
		}
	})

	// Reaper — leader-only.
	go queue.RunAsLeader(ctx, s.DB, logger, "reaper", queue.LockKeyReaper, 30*time.Second, func(ctx context.Context) {
		r := &queue.Reaper{Store: s, Logger: logger, Threshold: 90 * time.Second, Interval: 60 * time.Second}
		r.Run(ctx)
	})

	// otelhttp.NewHandler emits http.server.request.duration (a histogram)
	// with method/status/scheme labels. Kleos's HighErrorRate and
	// HighP99Latency alerts read the Prometheus-derived counterpart
	// (http_server_request_duration_seconds_*).
	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: otelhttp.NewHandler(api.NewRouter(api.Deps{
			Store:         s,
			Logger:        logger,
			AuthVerifier:  verifier,
			DevActorID:    "dev-actor",
			EmbedClient:   embedClient,
			EmbedDisabled: cfg.EmbedDisabled,
		}), "server"),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			os.Exit(5)
		}
	}()

	<-ctx.Done()
	logger.Info("shutdown signal received")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown", "err", err)
	}
	<-poolDone
	// Flush remaining metrics so the final batch (including any breaker
	// transitions during shutdown) reaches Prometheus.
	if mp != nil {
		if err := mp.Shutdown(shutdownCtx); err != nil {
			logger.Warn("metrics shutdown", "err", err)
		}
	}
}

// healthzExit probes the locally-listening /healthz and exits 0 on
// HTTP 200, 1 otherwise. Invoked via `mnemo-server healthz` from the
// container healthcheck; the distroless base has no probe tools, so
// the binary has to act as its own probe.
func healthzExit() {
	port := os.Getenv("MNEMO_PORT")
	if port == "" {
		port = "8080"
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		os.Exit(1)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
	os.Exit(0)
}

// buildLLMProviders materializes cfg.LLMProviders into a chain. The list is
// validated at config load, so we only need to map name → constructed Client.
//
// Each provider's Client is wrapped with llm.NewMetered so every Complete()
// call emits llm_request_duration_seconds and llm_tokens_used_total under the
// provider's name. Wrapping here (not around the Chain) means single-provider
// deployments, which use the bare Client without a Chain, are instrumented too.
func buildLLMProviders(cfg config.Config, metrics llm.LLMMetrics) ([]llm.Provider, error) {
	if len(cfg.LLMProviders) == 0 {
		return nil, errors.New("no LLM providers configured")
	}
	out := make([]llm.Provider, 0, len(cfg.LLMProviders))
	for _, name := range cfg.LLMProviders {
		switch name {
		case "anthropic":
			out = append(out, llm.Provider{
				Name:   "anthropic",
				Client: llm.NewMetered("anthropic", &llm.Anthropic{APIKey: cfg.AnthropicAPIKey}, metrics),
				Model:  cfg.AnthropicModel,
			})
		case "openai":
			out = append(out, llm.Provider{
				Name:   "openai",
				Client: llm.NewMetered("openai", &llm.OpenAI{APIKey: cfg.OpenAIAPIKey}, metrics),
				Model:  cfg.OpenAIModel,
			})
		case "xai":
			out = append(out, llm.Provider{
				Name:   "xai",
				Client: llm.NewMetered("xai", &llm.OpenAI{Name: "xai", APIKey: cfg.XAIAPIKey, Endpoint: llm.XAIEndpoint}, metrics),
				Model:  cfg.XAIModel,
			})
		case "gemini":
			out = append(out, llm.Provider{
				Name:   "gemini",
				Client: llm.NewMetered("gemini", &llm.OpenAI{Name: "gemini", APIKey: cfg.GeminiAPIKey, Endpoint: llm.GeminiEndpoint}, metrics),
				Model:  cfg.GeminiModel,
			})
		default:
			return nil, errors.New("unknown LLM provider: " + name)
		}
	}
	return out, nil
}
