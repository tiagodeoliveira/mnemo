package embed

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"math"
)

// Stub is a deterministic embedding client for tests. Given the same input,
// produces the same vector. The vector is NOT semantically meaningful — it's
// derived from a hash of the input text — but it IS stable, so tests can
// assert similarity ordering on canned inputs without flakiness.
type Stub struct {
	Dim int // default 1536 if zero
}

func (s *Stub) Dimensions() int {
	if s.Dim == 0 {
		return 1536
	}
	return s.Dim
}

func (s *Stub) Embed(_ context.Context, req EmbedRequest) (EmbedResponse, error) {
	dim := s.Dimensions()
	out := make([][]float32, len(req.Texts))
	for i, t := range req.Texts {
		out[i] = hashToVector(t, dim)
	}
	return EmbedResponse{Vectors: out, TokensUsed: 0}, nil
}

// hashToVector produces a deterministic unit-length vector from a string.
// Uses SHA-256 of the text repeatedly to seed enough bytes for `dim` float32s.
func hashToVector(text string, dim int) []float32 {
	vec := make([]float32, dim)
	seed := []byte(text)
	var norm float64
	written := 0
	for written < dim {
		h := sha256.Sum256(seed)
		for i := 0; i+4 <= len(h) && written < dim; i += 4 {
			v := float32(int32(binary.BigEndian.Uint32(h[i:i+4]))) / float32(1<<31)
			vec[written] = v
			norm += float64(v) * float64(v)
			written++
		}
		seed = h[:]
	}
	// Normalize so cosine similarity behaves predictably.
	if norm > 0 {
		invNorm := float32(1.0 / math.Sqrt(norm))
		for i := range vec {
			vec[i] *= invNorm
		}
	}
	return vec
}
