package llm

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type slowClient struct {
	delay time.Duration
	peak  atomic.Int32
	cur   atomic.Int32
}

func (s *slowClient) Complete(ctx context.Context, _ CompleteRequest) (CompleteResponse, error) {
	n := s.cur.Add(1)
	if n > s.peak.Load() {
		s.peak.Store(n)
	}
	defer s.cur.Add(-1)
	select {
	case <-ctx.Done():
		return CompleteResponse{}, ctx.Err()
	case <-time.After(s.delay):
	}
	return CompleteResponse{}, nil
}

func TestThrottleLimitsConcurrency(t *testing.T) {
	inner := &slowClient{delay: 50 * time.Millisecond}
	throttled := NewThrottled(inner, 2)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = throttled.Complete(context.Background(), CompleteRequest{})
		}()
	}
	wg.Wait()

	if peak := inner.peak.Load(); peak > 2 {
		t.Fatalf("concurrency exceeded throttle: peak=%d", peak)
	}
}

func TestThrottleDisabledWhenMaxZero(t *testing.T) {
	inner := &slowClient{}
	got := NewThrottled(inner, 0)
	if got != Client(inner) {
		t.Fatalf("expected pass-through when max=0")
	}
}

func TestThrottleRespectsCtxCancel(t *testing.T) {
	inner := &slowClient{delay: 10 * time.Second}
	throttled := NewThrottled(inner, 1)

	// First call holds the only slot.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = throttled.Complete(context.Background(), CompleteRequest{})
	}()
	// Wait briefly so the first call has acquired the slot.
	time.Sleep(50 * time.Millisecond)

	// Second call with a cancelable context — should return when ctx is done,
	// not block on the semaphore.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_, _ = throttled.Complete(ctx, CompleteRequest{})
		close(done)
	}()
	cancel()
	select {
	case <-done:
		// OK — returned promptly after cancel.
	case <-time.After(time.Second):
		t.Fatal("Complete did not return after ctx cancel")
	}
}
