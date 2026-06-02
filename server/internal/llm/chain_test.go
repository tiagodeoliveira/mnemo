package llm

import (
	"context"
	"errors"
	"testing"
	"time"
)

type stubClient struct {
	resp CompleteResponse
	err  error
	seen []CompleteRequest
}

func (s *stubClient) Complete(_ context.Context, req CompleteRequest) (CompleteResponse, error) {
	s.seen = append(s.seen, req)
	return s.resp, s.err
}

func TestChainSuccessOnPrimaryShortCircuits(t *testing.T) {
	primary := &stubClient{resp: CompleteResponse{Text: "ok"}}
	secondary := &stubClient{resp: CompleteResponse{Text: "should not run"}}
	c := NewChain([]Provider{
		{Name: "primary", Client: primary, Model: "p-model"},
		{Name: "secondary", Client: secondary, Model: "s-model"},
	}, 3, time.Minute, nil, nil)

	resp, err := c.Complete(context.Background(), CompleteRequest{Model: "ignored"})
	if err != nil || resp.Text != "ok" {
		t.Fatalf("primary win: resp=%+v err=%v", resp, err)
	}
	if len(secondary.seen) != 0 {
		t.Fatal("secondary must not be called on primary success")
	}
	if primary.seen[0].Model != "p-model" {
		t.Fatalf("provider model override not applied: %q", primary.seen[0].Model)
	}
}

func TestChainFailsOverToSecondary(t *testing.T) {
	primary := &stubClient{err: errors.New("upstream broken")}
	secondary := &stubClient{resp: CompleteResponse{Text: "saved you"}}
	c := NewChain([]Provider{
		{Name: "primary", Client: primary, Model: "p-model"},
		{Name: "secondary", Client: secondary, Model: "s-model"},
	}, 3, time.Minute, nil, nil)

	resp, err := c.Complete(context.Background(), CompleteRequest{})
	if err != nil || resp.Text != "saved you" {
		t.Fatalf("expected failover, got resp=%+v err=%v", resp, err)
	}
	if secondary.seen[0].Model != "s-model" {
		t.Fatalf("secondary model not applied: %q", secondary.seen[0].Model)
	}
}

func TestChainSkipsOpenBreaker(t *testing.T) {
	primary := &stubClient{err: errors.New("nope")}
	secondary := &stubClient{resp: CompleteResponse{Text: "secondary"}}
	c := NewChain([]Provider{
		{Name: "primary", Client: primary},
		{Name: "secondary", Client: secondary},
	}, 1, time.Hour, nil, nil)

	// First call trips the primary breaker.
	_, _ = c.Complete(context.Background(), CompleteRequest{})
	if c.Breakers[0].State() != "open" {
		t.Fatalf("primary breaker should be open, got %s", c.Breakers[0].State())
	}

	// Second call must skip primary entirely.
	before := len(primary.seen)
	resp, err := c.Complete(context.Background(), CompleteRequest{})
	if err != nil || resp.Text != "secondary" {
		t.Fatalf("expected secondary response, got resp=%+v err=%v", resp, err)
	}
	if len(primary.seen) != before {
		t.Fatal("primary must be skipped while its breaker is open")
	}
}

func TestChainReturnsLastErrWhenAllFail(t *testing.T) {
	primary := &stubClient{err: errors.New("first")}
	secondary := &stubClient{err: errors.New("second")}
	c := NewChain([]Provider{
		{Name: "primary", Client: primary},
		{Name: "secondary", Client: secondary},
	}, 3, time.Minute, nil, nil)

	_, err := c.Complete(context.Background(), CompleteRequest{})
	if err == nil || err.Error() != "second" {
		t.Fatalf("expected last err 'second', got %v", err)
	}
}

func TestChainPropagatesCtxErrImmediately(t *testing.T) {
	// Primary fails; while we'd normally fail over, ctx was cancelled mid-call.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	primary := &stubClient{err: errors.New("nope")}
	secondary := &stubClient{resp: CompleteResponse{Text: "would have worked"}}
	c := NewChain([]Provider{
		{Name: "primary", Client: primary},
		{Name: "secondary", Client: secondary},
	}, 3, time.Minute, nil, nil)

	_, err := c.Complete(ctx, CompleteRequest{})
	if err == nil {
		t.Fatal("expected ctx err")
	}
	if len(secondary.seen) != 0 {
		t.Fatal("secondary must not be called once ctx is dead")
	}
}

func TestChainExhaustedWhenAllBreakersOpen(t *testing.T) {
	primary := &stubClient{err: errors.New("trip me")}
	c := NewChain([]Provider{{Name: "only", Client: primary}}, 1, time.Hour, nil, nil)
	_, _ = c.Complete(context.Background(), CompleteRequest{}) // trips breaker
	_, err := c.Complete(context.Background(), CompleteRequest{})
	if !errors.Is(err, ErrChainExhausted) {
		t.Fatalf("expected ErrChainExhausted, got %v", err)
	}
}
