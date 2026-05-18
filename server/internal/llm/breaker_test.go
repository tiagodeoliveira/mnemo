package llm

import (
	"testing"
	"time"
)

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
