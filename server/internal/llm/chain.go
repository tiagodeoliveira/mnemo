package llm

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

// Provider names a backend client and the model string to send through it.
// The chain swaps req.Model with Provider.Model before delegating, so callers
// can issue a single CompleteRequest without knowing which backend it lands on.
type Provider struct {
	Name   string
	Client Client
	Model  string // overrides req.Model if non-empty
}

// Chain tries providers in order. A provider whose breaker is open is skipped.
// On a provider error the breaker registers a failure and the chain moves to
// the next provider; on success it returns immediately.
//
// We don't classify errors as transient vs permanent: failing over on a
// permanent error wastes at most one extra call, while a classification table
// would need ongoing upkeep. The breaker bounds the waste.
type Chain struct {
	Providers []Provider
	Breakers  []*Breaker
	Logger    *slog.Logger
}

// NewChain wires up a chain with one breaker per provider. Breaker tuning is
// shared across providers for simplicity; tune per-provider if a hot backend
// needs a different cadence.
func NewChain(providers []Provider, threshold int, cooldown time.Duration, logger *slog.Logger) *Chain {
	bs := make([]*Breaker, len(providers))
	for i := range providers {
		bs[i] = &Breaker{Threshold: threshold, Cooldown: cooldown}
	}
	return &Chain{Providers: providers, Breakers: bs, Logger: logger}
}

// ErrChainExhausted is returned when every provider's breaker is open and no
// underlying error was produced this call. Distinct from a wrapped provider
// error so callers can detect "everyone is in cooldown" cleanly.
var ErrChainExhausted = errors.New("llm chain: all providers unavailable")

func (c *Chain) Complete(ctx context.Context, req CompleteRequest) (CompleteResponse, error) {
	var lastErr error
	for i, p := range c.Providers {
		if ctx.Err() != nil {
			return CompleteResponse{}, ctx.Err()
		}
		if !c.Breakers[i].Allow() {
			if c.Logger != nil {
				c.Logger.Debug("llm chain: skipping provider (breaker open)", "provider", p.Name)
			}
			continue
		}
		r := req
		if p.Model != "" {
			r.Model = p.Model
		}
		resp, err := p.Client.Complete(ctx, r)
		if err == nil {
			c.Breakers[i].Success()
			return resp, nil
		}
		// If the caller's context died mid-call, propagate immediately —
		// trying the next provider would hit the same deadline.
		if ctx.Err() != nil {
			return CompleteResponse{}, ctx.Err()
		}
		c.Breakers[i].Failure()
		lastErr = err
		if c.Logger != nil {
			c.Logger.Warn("llm chain: provider failed",
				"provider", p.Name,
				"breaker", c.Breakers[i].State(),
				"err", err)
		}
	}
	if lastErr == nil {
		return CompleteResponse{}, ErrChainExhausted
	}
	return CompleteResponse{}, lastErr
}
