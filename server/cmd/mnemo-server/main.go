package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
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
	"github.com/tiagodeoliveira/mnemo/server/internal/queue"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config", "err", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("store.Open", "err", err)
		os.Exit(3)
	}
	defer s.Close()

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
	if cfg.LLMDisabled {
		rawLlm = &llm.Stub{}
		logger.Warn("MNEMO_LLM_DISABLED=1: using stub LLM")
	} else {
		if cfg.AnthropicAPIKey == "" {
			logger.Error("ANTHROPIC_API_KEY required when MNEMO_LLM_DISABLED is not set")
			os.Exit(7)
		}
		rawLlm = &llm.Anthropic{APIKey: cfg.AnthropicAPIKey}
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
		Store: s, LLM: llmClient, Model: cfg.LLMModel,
		Embed: embedClient, EmbedDisabled: cfg.EmbedDisabled,
	}
	meetingHandler := &meeting.Handler{
		Store: s, LLM: llmClient, Model: cfg.LLMModel,
		Embed: embedClient, EmbedDisabled: cfg.EmbedDisabled,
	}
	mailer := &digest.Mailer{
		Host: cfg.SMTPHost,
		User: cfg.SMTPUser,
		Pass: cfg.SMTPPass,
		From: cfg.SMTPFrom,
	}
	digestHandler := &digest.Handler{
		Store: s, LLM: llmClient, Model: cfg.LLMModel, Mailer: mailer,
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
	logger.Info("worker pool starting", "workers", cfg.WorkerCount, "handlers", registered)
	pool := queue.NewPool(s, logger, cfg.WorkerCount, handlers)
	poolDone := make(chan struct{})
	go func() { pool.Run(ctx); close(poolDone) }()

	sched := &digest.Scheduler{Store: s, Logger: logger, DigestHour: 19}
	go sched.Run(ctx)

	go queue.Sweeper(ctx, s, logger, 7*24*time.Hour, time.Hour)

	// Backfill embeddings scheduler: runs every 5 minutes.
	go func() {
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
	}()

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: api.NewRouter(api.Deps{
			Store:         s,
			Logger:        logger,
			AuthVerifier:  verifier,
			DevActorID:    "dev-actor",
			EmbedClient:   embedClient,
			EmbedDisabled: cfg.EmbedDisabled,
		}),
		ReadHeaderTimeout: 5 * time.Second,
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
}
