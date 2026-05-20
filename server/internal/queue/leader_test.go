package queue

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Use a high random key per test to avoid cross-test interference.
const testLockBase int64 = 0x7000_0000_0000_0000

func newStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := startPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestLeader_OnlyOneAcquires(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var got1, got2 atomic.Bool
	go RunAsLeader(ctx, s.DB, logger, "test1", testLockBase+1, 100*time.Millisecond, func(ctx context.Context) {
		got1.Store(true)
		<-ctx.Done()
	})
	// Race the second one slightly later so the first wins deterministically.
	time.Sleep(200 * time.Millisecond)
	go RunAsLeader(ctx, s.DB, logger, "test1-rival", testLockBase+1, 100*time.Millisecond, func(ctx context.Context) {
		got2.Store(true)
		<-ctx.Done()
	})

	time.Sleep(500 * time.Millisecond)
	if !got1.Load() {
		t.Fatal("first leader did not acquire")
	}
	if got2.Load() {
		t.Fatal("second instance acquired the same lock")
	}
	cancel()
	time.Sleep(200 * time.Millisecond)
}

func TestLeader_DifferentKeysCoexist(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var got1, got2 atomic.Bool
	go RunAsLeader(ctx, s.DB, logger, "k1", testLockBase+2, 100*time.Millisecond, func(ctx context.Context) {
		got1.Store(true)
		<-ctx.Done()
	})
	go RunAsLeader(ctx, s.DB, logger, "k2", testLockBase+3, 100*time.Millisecond, func(ctx context.Context) {
		got2.Store(true)
		<-ctx.Done()
	})

	time.Sleep(500 * time.Millisecond)
	if !got1.Load() || !got2.Load() {
		t.Fatalf("expected both to acquire (different keys); got1=%v got2=%v", got1.Load(), got2.Load())
	}
	cancel()
	time.Sleep(200 * time.Millisecond)
}

func TestLeader_HandoffAfterCancel(t *testing.T) {
	s := newStore(t)
	defer func() { _ = s.Close() }()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	ctx1, cancel1 := context.WithCancel(context.Background())
	var first atomic.Bool
	go RunAsLeader(ctx1, s.DB, logger, "p1", testLockBase+4, 100*time.Millisecond, func(ctx context.Context) {
		first.Store(true)
		<-ctx.Done()
	})
	time.Sleep(300 * time.Millisecond)
	if !first.Load() {
		t.Fatal("first did not acquire")
	}

	// Start a second contender; it shouldn't acquire while the first is alive.
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	var second atomic.Bool
	go RunAsLeader(ctx2, s.DB, logger, "p2", testLockBase+4, 100*time.Millisecond, func(ctx context.Context) {
		second.Store(true)
		<-ctx.Done()
	})
	time.Sleep(300 * time.Millisecond)
	if second.Load() {
		t.Fatal("second acquired while first was alive")
	}

	// Kill the first. Second should pick up.
	cancel1()
	time.Sleep(700 * time.Millisecond)
	if !second.Load() {
		t.Fatal("second did not acquire after first died")
	}
}
