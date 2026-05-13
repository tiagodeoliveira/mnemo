package llm

import "context"

// Stub returns canned responses keyed by an inspection of the request.
type Stub struct {
	Handler func(req CompleteRequest) (CompleteResponse, error)
}

func (s *Stub) Complete(_ context.Context, req CompleteRequest) (CompleteResponse, error) {
	if s.Handler == nil {
		return CompleteResponse{Text: "{}"}, nil
	}
	return s.Handler(req)
}
