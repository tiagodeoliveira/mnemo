package llm

import (
	"sync"
	"testing"
	"time"
)

// fakeBreakerMetrics records every Transition call. Safe under the
// breaker's own lock since Transition is invoked while b.mu is held.
type fakeBreakerMetrics struct {
	mu     sync.Mutex
	events []struct{ name, state string }
}

func (f *fakeBreakerMetrics) Transition(name, toState string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, struct{ name, state string }{name, toState})
}

func (f *fakeBreakerMetrics) snapshot() []struct{ name, state string } {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]struct{ name, state string }, len(f.events))
	copy(out, f.events)
	return out
}

func TestBreakerEmitsOpenAfterThreshold(t *testing.T) {
	fake := &fakeBreakerMetrics{}
	b := &Breaker{Name: "llm.test", Threshold: 3, Cooldown: time.Hour, Metrics: fake}

	b.Failure()
	b.Failure()
	if got := len(fake.snapshot()); got != 0 {
		t.Fatalf("two failures shouldn't emit; got %d events: %+v", got, fake.snapshot())
	}

	b.Failure()
	events := fake.snapshot()
	if len(events) != 1 || events[0].state != "open" || events[0].name != "llm.test" {
		t.Fatalf("expected single open event for llm.test, got %+v", events)
	}
}

func TestBreakerDoesNotEmitOnIdempotentSuccess(t *testing.T) {
	fake := &fakeBreakerMetrics{}
	b := &Breaker{Name: "llm.test", Threshold: 3, Cooldown: time.Hour, Metrics: fake}
	// Repeated Success on a closed breaker must not inflate the transitions
	// counter — otherwise every healthy LLM call would tick `closed` once.
	for i := 0; i < 100; i++ {
		b.Success()
	}
	if got := len(fake.snapshot()); got != 0 {
		t.Fatalf("idempotent Success leaked events: %+v", fake.snapshot())
	}
}

func TestBreakerEmitsHalfOpenOnProbeAdmit(t *testing.T) {
	fake := &fakeBreakerMetrics{}
	b := &Breaker{Name: "llm.test", Threshold: 1, Cooldown: 5 * time.Millisecond, Metrics: fake}

	b.Failure()
	if got := fake.snapshot(); len(got) != 1 || got[0].state != "open" {
		t.Fatalf("expected open after first failure, got %+v", got)
	}
	if b.Allow() {
		t.Fatal("Allow should deny before cooldown")
	}
	if got := len(fake.snapshot()); got != 1 {
		t.Fatalf("denied Allow shouldn't emit; got %d events", got)
	}
	time.Sleep(10 * time.Millisecond)
	if !b.Allow() {
		t.Fatal("Allow should admit probe after cooldown")
	}
	events := fake.snapshot()
	if len(events) != 2 || events[1].state != "half_open" {
		t.Fatalf("expected half_open after probe admit, got %+v", events)
	}
}

func TestBreakerProbeSuccessClosesAndEmits(t *testing.T) {
	fake := &fakeBreakerMetrics{}
	b := &Breaker{Name: "llm.test", Threshold: 1, Cooldown: 5 * time.Millisecond, Metrics: fake}
	b.Failure()
	time.Sleep(10 * time.Millisecond)
	b.Allow() // → half_open
	b.Success()
	events := fake.snapshot()
	if len(events) != 3 {
		t.Fatalf("expected 3 events (open, half_open, closed), got %+v", events)
	}
	if events[0].state != "open" || events[1].state != "half_open" || events[2].state != "closed" {
		t.Fatalf("unexpected order: %+v", events)
	}
}

func TestBreakerProbeFailureReopens(t *testing.T) {
	fake := &fakeBreakerMetrics{}
	b := &Breaker{Name: "llm.test", Threshold: 1, Cooldown: 5 * time.Millisecond, Metrics: fake}
	b.Failure()
	time.Sleep(10 * time.Millisecond)
	b.Allow()
	b.Failure()
	wantStates := []string{"open", "half_open", "open"}
	events := fake.snapshot()
	if len(events) != len(wantStates) {
		t.Fatalf("expected %d events, got %+v", len(wantStates), events)
	}
	for i, want := range wantStates {
		if events[i].state != want {
			t.Fatalf("event %d: want %s, got %s (full: %+v)", i, want, events[i].state, events)
		}
	}
}

func TestBreakerNilMetricsIsSafe(t *testing.T) {
	b := &Breaker{Name: "llm.test", Threshold: 1, Cooldown: time.Hour, Metrics: nil}
	b.Failure()
	if b.State() != "open" {
		t.Fatalf("expected open, got %s", b.State())
	}
	b.Success()
	if b.State() != "closed" {
		t.Fatalf("expected closed, got %s", b.State())
	}
}

func TestBreakerClosedToOpenAfterThreshold(t *testing.T) {
	b := &Breaker{Threshold: 3, Cooldown: time.Minute}
	for i := 0; i < 2; i++ {
		if !b.Allow() {
			t.Fatalf("call %d: should allow while under threshold", i)
		}
		b.Failure()
	}
	if !b.Allow() {
		t.Fatalf("call 2: still under threshold, should allow")
	}
	b.Failure()
	if b.State() != "open" {
		t.Fatalf("after 3rd failure, want open, got %s", b.State())
	}
	if b.Allow() {
		t.Fatal("open breaker must not allow during cooldown")
	}
}

func TestBreakerHalfOpenSuccessClosesIt(t *testing.T) {
	b := &Breaker{Threshold: 1, Cooldown: 10 * time.Millisecond}
	b.Failure() // trip open
	if b.State() != "open" {
		t.Fatal("expected open")
	}
	time.Sleep(15 * time.Millisecond)
	if !b.Allow() {
		t.Fatal("after cooldown, half-open probe should be allowed")
	}
	if b.State() != "half-open" {
		t.Fatalf("expected half-open, got %s", b.State())
	}
	// Second concurrent call in half-open: blocked until probe resolves.
	if b.Allow() {
		t.Fatal("only one probe call permitted in half-open")
	}
	b.Success()
	if b.State() != "closed" {
		t.Fatalf("after probe success, want closed, got %s", b.State())
	}
}

func TestBreakerHalfOpenFailureReopens(t *testing.T) {
	b := &Breaker{Threshold: 1, Cooldown: 10 * time.Millisecond}
	b.Failure()
	time.Sleep(15 * time.Millisecond)
	b.Allow()
	b.Failure()
	if b.State() != "open" {
		t.Fatalf("probe failure must reopen, got %s", b.State())
	}
	// Cooldown clock should have reset, not be measured from the original open.
	if b.Allow() {
		t.Fatal("reopened breaker must not admit immediately")
	}
}

func TestBreakerSuccessResetsFailureCount(t *testing.T) {
	b := &Breaker{Threshold: 3, Cooldown: time.Minute}
	b.Failure()
	b.Failure()
	b.Success()
	b.Failure()
	b.Failure()
	if b.State() != "closed" {
		t.Fatalf("success should reset the counter, got %s", b.State())
	}
}
