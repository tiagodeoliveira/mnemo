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

	handlers := map[store.JobKind]queue.Handler{
		// Registered in later phases.
	}
	pool := queue.NewPool(s, logger, cfg.WorkerCount, handlers)
	poolDone := make(chan struct{})
	go func() { pool.Run(ctx); close(poolDone) }()

	go queue.Sweeper(ctx, s, logger, 7*24*time.Hour, time.Hour)

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: api.NewRouter(api.Deps{
			Store:        s,
			Logger:       logger,
			AuthVerifier: verifier,
			DevActorID:   "dev-actor",
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
