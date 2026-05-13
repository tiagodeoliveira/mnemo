package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		logger.Error("DATABASE_URL is required")
		os.Exit(2)
	}

	ctx := context.Background()
	s, err := store.Open(ctx, dsn)
	if err != nil {
		logger.Error("store.Open failed", "err", err)
		os.Exit(3)
	}
	defer s.Close()

	if err := s.Migrate(); err != nil {
		logger.Error("migrate failed", "err", err)
		os.Exit(4)
	}
	logger.Info("migrations applied")
}
