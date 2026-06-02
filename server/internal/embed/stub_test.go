package embed

import (
	"context"
	"testing"
)

func TestStubIsDeterministic(t *testing.T) {
	s := &Stub{}
	r1, _ := s.Embed(context.Background(), EmbedRequest{Texts: []string{"hello"}})
	r2, _ := s.Embed(context.Background(), EmbedRequest{Texts: []string{"hello"}})
	if r1.Vectors[0][0] != r2.Vectors[0][0] {
		t.Fatalf("stub not deterministic")
	}
}

func TestStubDifferentInputsDiffer(t *testing.T) {
	s := &Stub{}
	r, _ := s.Embed(context.Background(), EmbedRequest{Texts: []string{"hello", "world"}})
	same := true
	for i := range r.Vectors[0] {
		if r.Vectors[0][i] != r.Vectors[1][i] {
			same = false
			break
		}
	}
	if same {
		t.Fatalf("different inputs produced identical vectors")
	}
}

func TestStubDimensions(t *testing.T) {
	if (&Stub{}).Dimensions() != 1536 {
		t.Fatalf("default dim should be 1536")
	}
	if (&Stub{Dim: 768}).Dimensions() != 768 {
		t.Fatalf("override dim should be respected")
	}
}

func TestStubNormalized(t *testing.T) {
	s := &Stub{}
	r, _ := s.Embed(context.Background(), EmbedRequest{Texts: []string{"normalization check"}})
	vec := r.Vectors[0]
	var norm float64
	for _, v := range vec {
		norm += float64(v) * float64(v)
	}
	// norm should be ~1.0 (unit vector)
	if norm < 0.99 || norm > 1.01 {
		t.Fatalf("vector not normalized: norm=%f", norm)
	}
}
