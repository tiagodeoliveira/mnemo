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

const anthropicVersion = "2023-06-01"
const defaultEndpoint = "https://api.anthropic.com/v1/messages"

type Anthropic struct {
	APIKey   string
	Endpoint string // override for tests
	HTTP     *http.Client
	Logger   func(format string, args ...any)
}

type anthropicReq struct {
	Model       string    `json:"model"`
	MaxTokens   int       `json:"max_tokens"`
	System      string    `json:"system,omitempty"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature,omitempty"`
}

type anthropicResp struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

func (a *Anthropic) Complete(ctx context.Context, in CompleteRequest) (CompleteResponse, error) {
	if a.HTTP == nil {
		a.HTTP = &http.Client{Timeout: 300 * time.Second}
	}
	endpoint := a.Endpoint
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	body := anthropicReq{
		Model:       in.Model,
		MaxTokens:   in.MaxTokens,
		System:      in.System,
		Messages:    in.Messages,
		Temperature: in.Temperature,
	}
	if body.MaxTokens == 0 {
		body.MaxTokens = 4096
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
	req.Header.Set("x-api-key", a.APIKey)
	req.Header.Set("anthropic-version", anthropicVersion)

	resp, err := a.HTTP.Do(req)
	if err != nil {
		return CompleteResponse{}, fmt.Errorf("anthropic: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return CompleteResponse{}, fmt.Errorf("anthropic: status %d: %s", resp.StatusCode, string(raw))
	}
	var parsed anthropicResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		preview := string(raw)
		if len(preview) > 500 {
			preview = preview[:500] + "…"
		}
		return CompleteResponse{}, fmt.Errorf("anthropic: decode (status=%d ct=%q): %w (body=%q)",
			resp.StatusCode, resp.Header.Get("content-type"), err, preview)
	}
	out := CompleteResponse{
		StopReason: parsed.StopReason,
		InputToks:  parsed.Usage.InputTokens,
		OutputToks: parsed.Usage.OutputTokens,
	}
	for _, c := range parsed.Content {
		if c.Type == "text" {
			out.Text += c.Text
		}
	}
	return out, nil
}
