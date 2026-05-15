package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const defaultOpenAIEndpoint = "https://api.openai.com/v1/embeddings"
const defaultOpenAIModel = "text-embedding-3-small"
const defaultOpenAIDimensions = 1536

// OpenAI is the default embed.Client backed by OpenAI's embedding API.
type OpenAI struct {
	APIKey   string
	Model    string // default text-embedding-3-small
	Endpoint string // override for tests
	HTTP     *http.Client
}

type openAIReq struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type openAIResp struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
		Index     int       `json:"index"`
	} `json:"data"`
	Usage struct {
		PromptTokens int `json:"prompt_tokens"`
	} `json:"usage"`
}

func (o *OpenAI) Dimensions() int { return defaultOpenAIDimensions }

func (o *OpenAI) Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error) {
	if o.HTTP == nil {
		o.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	endpoint := o.Endpoint
	if endpoint == "" {
		endpoint = defaultOpenAIEndpoint
	}
	model := req.Model
	if model == "" {
		model = o.Model
	}
	if model == "" {
		model = defaultOpenAIModel
	}
	if len(req.Texts) == 0 {
		return EmbedResponse{}, nil
	}
	body, err := json.Marshal(openAIReq{Model: model, Input: req.Texts})
	if err != nil {
		return EmbedResponse{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return EmbedResponse{}, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+o.APIKey)

	resp, err := o.HTTP.Do(httpReq)
	if err != nil {
		return EmbedResponse{}, fmt.Errorf("openai embed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return EmbedResponse{}, fmt.Errorf("openai embed: status %d: %s", resp.StatusCode, string(raw))
	}
	var parsed openAIResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return EmbedResponse{}, fmt.Errorf("openai embed: decode: %w", err)
	}
	// Order by Index to be defensive; OpenAI usually returns in input order.
	out := make([][]float32, len(req.Texts))
	for _, d := range parsed.Data {
		if d.Index < 0 || d.Index >= len(out) {
			continue
		}
		out[d.Index] = d.Embedding
	}
	return EmbedResponse{Vectors: out, TokensUsed: parsed.Usage.PromptTokens}, nil
}
