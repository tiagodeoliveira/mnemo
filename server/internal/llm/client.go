package llm

import "context"

// LongFormMaxTokens is the budget for consolidation, daily-digest, and
// meeting-summary calls. Sized to accommodate the longest realistic diff
// or digest body without truncation — see the StopReason == "max_tokens"
// branches in those handlers.
const LongFormMaxTokens = 8192

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
