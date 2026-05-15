package llm

import "context"

// Throttled wraps a Client with a bounded semaphore that caps the number of
// concurrent in-flight Complete() calls. Protects against burst-rate-limiting
// from upstream providers (e.g., Anthropic 529 Overloaded under high concurrency).
//
// All Complete() calls share the same semaphore regardless of which job type
// issued them (extract_context, meeting finalizer, daily digest, etc.). This
// bounds total concurrent LLM pressure across all workers.
type Throttled struct {
	Inner Client
	sem   chan struct{}
}

// NewThrottled wraps inner with a semaphore of size max. max<=0 disables
// throttling and returns inner directly.
func NewThrottled(inner Client, max int) Client {
	if max <= 0 {
		return inner
	}
	return &Throttled{Inner: inner, sem: make(chan struct{}, max)}
}

func (t *Throttled) Complete(ctx context.Context, req CompleteRequest) (CompleteResponse, error) {
	// Acquire slot, or fail fast if context is cancelled.
	select {
	case t.sem <- struct{}{}:
	case <-ctx.Done():
		return CompleteResponse{}, ctx.Err()
	}
	defer func() { <-t.sem }()
	return t.Inner.Complete(ctx, req)
}
