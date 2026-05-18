package llm

import (
	"sync"
	"time"
)

// breakerState is the circuit state of a single provider.
type breakerState int

const (
	breakerClosed   breakerState = iota // calls flow normally
	breakerOpen                         // calls short-circuited; cooldown in progress
	breakerHalfOpen                     // one probe call allowed to retest the upstream
)

// Breaker tracks consecutive failures against one provider and trips open once
// the threshold is exceeded. After Cooldown elapses, it admits a single probe
// call (half-open); the probe's outcome decides whether to close or re-open.
//
// Methods are safe for concurrent use.
type Breaker struct {
	Threshold int           // consecutive failures that open the breaker
	Cooldown  time.Duration // time to stay open before allowing a probe

	mu             sync.Mutex
	state          breakerState
	failures       int
	openedAt       time.Time
	probeInFlight  bool
}

// Allow reports whether a call may proceed. Callers MUST call Success or
// Failure for each call they made after Allow returned true, so the breaker
// state machine advances correctly.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case breakerClosed:
		return true
	case breakerOpen:
		if time.Since(b.openedAt) >= b.Cooldown {
			b.state = breakerHalfOpen
			b.probeInFlight = true
			return true
		}
		return false
	case breakerHalfOpen:
		if b.probeInFlight {
			return false
		}
		b.probeInFlight = true
		return true
	}
	return false
}

func (b *Breaker) Success() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state = breakerClosed
	b.failures = 0
	b.probeInFlight = false
}

func (b *Breaker) Failure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.probeInFlight = false
	if b.state == breakerHalfOpen {
		b.state = breakerOpen
		b.openedAt = time.Now()
		return
	}
	b.failures++
	if b.failures >= b.Threshold {
		b.state = breakerOpen
		b.openedAt = time.Now()
	}
}

// State exposes the current state for logging/metrics. Returns one of
// "closed", "open", "half-open".
func (b *Breaker) State() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case breakerClosed:
		return "closed"
	case breakerOpen:
		return "open"
	case breakerHalfOpen:
		return "half-open"
	}
	return "unknown"
}
