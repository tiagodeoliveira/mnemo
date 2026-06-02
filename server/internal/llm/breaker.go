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

// BreakerMetrics receives state-transition notifications so a metrics
// emitter (or a test fake) can observe breaker behaviour. Implementations
// MUST be safe for concurrent use; the Breaker calls Transition while
// holding its own lock. Pass nil to opt out.
//
// The `name` argument is the breaker's identity (e.g. "llm.anthropic");
// `toState` is one of "closed", "open", "half_open" — note the
// underscore, matching the Prometheus label vocabulary the alerts read.
type BreakerMetrics interface {
	Transition(name, toState string)
}

// Breaker tracks consecutive failures against one provider and trips open once
// the threshold is exceeded. After Cooldown elapses, it admits a single probe
// call (half-open); the probe's outcome decides whether to close or re-open.
//
// Methods are safe for concurrent use.
type Breaker struct {
	Name      string         // identity used in metric labels; e.g. "llm.anthropic"
	Threshold int            // consecutive failures that open the breaker
	Cooldown  time.Duration  // time to stay open before allowing a probe
	Metrics   BreakerMetrics // optional; nil = no emission

	mu            sync.Mutex
	state         breakerState
	failures      int
	openedAt      time.Time
	probeInFlight bool
}

// metricLabel maps the internal state enum to the metric label vocabulary
// (`closed`, `open`, `half_open` — underscore, not hyphen).
func metricLabel(s breakerState) string {
	switch s {
	case breakerClosed:
		return "closed"
	case breakerOpen:
		return "open"
	case breakerHalfOpen:
		return "half_open"
	}
	return "unknown"
}

// transitionLocked changes state and emits a metric transition. Caller
// MUST hold b.mu. No-op if `to` equals the current state — keeps the
// transitions counter from inflating on idempotent Success() calls.
func (b *Breaker) transitionLocked(to breakerState) {
	if b.state == to {
		return
	}
	b.state = to
	if b.Metrics != nil {
		b.Metrics.Transition(b.Name, metricLabel(to))
	}
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
			b.transitionLocked(breakerHalfOpen)
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
	b.transitionLocked(breakerClosed)
	b.failures = 0
	b.probeInFlight = false
}

func (b *Breaker) Failure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.probeInFlight = false
	if b.state == breakerHalfOpen {
		b.transitionLocked(breakerOpen)
		b.openedAt = time.Now()
		return
	}
	b.failures++
	if b.failures >= b.Threshold {
		b.transitionLocked(breakerOpen)
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
