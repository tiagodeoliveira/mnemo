package embed

import "context"

// EmbedRequest carries one or more texts to embed.
type EmbedRequest struct {
	Texts []string
	Model string // optional override; client falls back to its default
}

// EmbedResponse returns parallel arrays of embeddings + usage stats.
type EmbedResponse struct {
	Vectors    [][]float32 // same length as Request.Texts, in order
	TokensUsed int         // total prompt tokens billed
}

// Client is the pluggable interface. Real impl in openai.go; deterministic
// stub in stub.go for tests; future bedrock / voyage / local impls slot in here.
type Client interface {
	Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error)
	// Dimensions returns the vector size this client produces. Used to
	// validate the schema column matches at startup.
	Dimensions() int
}
