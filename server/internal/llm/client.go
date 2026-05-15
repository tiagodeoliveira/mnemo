package llm

import "context"

type Message struct {
	Role    string `json:"role"`    // "user" or "assistant"
	Content string `json:"content"`
}

type CompleteRequest struct {
	System      string
	Messages    []Message
	Model       string
	MaxTokens   int
	Temperature float64
	JSONOutput  bool // if true, instruct model to emit pure JSON
}

type CompleteResponse struct {
	Text       string
	StopReason string
	InputToks  int
	OutputToks int
}

type Client interface {
	Complete(ctx context.Context, req CompleteRequest) (CompleteResponse, error)
}
