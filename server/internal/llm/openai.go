package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const openaiDefaultEndpoint = "https://api.openai.com/v1/chat/completions"

// XAIEndpoint and GeminiEndpoint are the OpenAI-compatible Chat Completions
// endpoints for xAI (Grok) and Google Gemini. Both speak the same wire format
// as OpenAI, so the OpenAI client serves them by overriding Endpoint + Name.
const (
	XAIEndpoint    = "https://api.x.ai/v1/chat/completions"
	GeminiEndpoint = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
)

// OpenAI implements Client against the Chat Completions API. It exists so we
// can fail over from Anthropic during back-pressure windows; the model knob
// is set per-provider in chain.go, so callers don't pick the model here.
//
// Because xAI and Gemini expose OpenAI-compatible endpoints, this same client
// backs those providers too — set Endpoint to the provider's URL and Name to
// its label so errors and APIError.Provider attribute to the right backend
// (a Gemini 400 must not read as "openai: ..." in the job-failed log).
type OpenAI struct {
	APIKey   string
	Endpoint string // override for tests; defaults to OpenAI's endpoint
	Name     string // provider label for errors; defaults to "openai"
	HTTP     *http.Client
}

// name returns the provider label used in error messages, defaulting to
// "openai" when unset so the original single-provider behavior is unchanged.
func (o *OpenAI) name() string {
	if o.Name != "" {
		return o.Name
	}
	return "openai"
}

type openaiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openaiReq struct {
	Model       string          `json:"model"`
	Messages    []openaiMessage `json:"messages"`
	MaxTokens   int             `json:"max_tokens,omitempty"`
	Temperature float64         `json:"temperature,omitempty"`
}

type openaiResp struct {
	Choices []struct {
		Message      openaiMessage `json:"message"`
		FinishReason string        `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func (o *OpenAI) Complete(ctx context.Context, in CompleteRequest) (CompleteResponse, error) {
	if o.HTTP == nil {
		o.HTTP = &http.Client{Timeout: 300 * time.Second}
	}
	endpoint := o.Endpoint
	if endpoint == "" {
		endpoint = openaiDefaultEndpoint
	}

	// OpenAI takes system as a message; translate from our top-level System field.
	msgs := make([]openaiMessage, 0, len(in.Messages)+1)
	if in.System != "" {
		msgs = append(msgs, openaiMessage{Role: "system", Content: in.System})
	}
	for _, m := range in.Messages {
		msgs = append(msgs, openaiMessage(m))
	}

	body := openaiReq{
		Model:       in.Model,
		Messages:    msgs,
		MaxTokens:   in.MaxTokens,
		Temperature: in.Temperature,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return CompleteResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(buf))
	if err != nil {
		return CompleteResponse{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+o.APIKey)

	resp, err := o.HTTP.Do(req)
	if err != nil {
		return CompleteResponse{}, fmt.Errorf("%s: %w", o.name(), err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return CompleteResponse{}, &APIError{Provider: o.name(), StatusCode: resp.StatusCode, Body: string(raw)}
	}
	var parsed openaiResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		preview := string(raw)
		if len(preview) > 500 {
			preview = preview[:500] + "…"
		}
		return CompleteResponse{}, fmt.Errorf("%s: decode (status=%d ct=%q): %w (body=%q)",
			o.name(), resp.StatusCode, resp.Header.Get("content-type"), err, preview)
	}
	if len(parsed.Choices) == 0 {
		return CompleteResponse{}, fmt.Errorf("%s: empty choices", o.name())
	}
	return CompleteResponse{
		Text:       parsed.Choices[0].Message.Content,
		StopReason: parsed.Choices[0].FinishReason,
		InputToks:  parsed.Usage.PromptTokens,
		OutputToks: parsed.Usage.CompletionTokens,
	}, nil
}
