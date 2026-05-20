package store

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
)

func TestSemanticSearch(t *testing.T) {
	dsn := startPG(t)
	s, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil {
		t.Fatal(err)
	}

	// Insert 3 items. Item 0 gets a specific vector; items 1 and 2 get different vectors.
	// We'll search using item 0's vector and expect it to be the top hit.
	ns := "/preferences/alice/"
	eventID := uuid.New()

	// Create simple test vectors. Dimension 1536.
	dim := 1536
	makeVec := func(seed float32) []float32 {
		v := make([]float32, dim)
		for i := range v {
			v[i] = seed
		}
		// normalize
		var norm float32
		for _, x := range v {
			norm += x * x
		}
		invNorm := float32(1.0)
		if norm > 0 {
			invNorm = 1.0 / float32(norm)
			// approximate sqrt via iteration
			z := invNorm / 2
			for i := 0; i < 6; i++ {
				z = (z + invNorm/z) / 2
			}
			invNorm = z
		}
		for i := range v {
			v[i] *= invNorm
		}
		return v
	}

	vec0 := makeVec(1.0) // query will be identical to this
	vec1 := makeVec(0.5) // different
	vec2 := makeVec(-1.0) // opposite direction

	items := []struct {
		content string
		dim     string
		ns      string
		tags    []string
		vec     []float32
	}{
		{"uses Go for backend services", "preferences", ns, []string{"language"}, vec0},
		{"prefers tabs over spaces", "preferences", ns, []string{"style"}, vec1},
		{"dislikes microservices", "about", "/about/alice/", []string{"architecture"}, vec2},
	}

	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, item := range items {
		id := uuid.New()
		tagsJSON := tagsToJSON(item.tags)
		_, err := tx.ExecContext(ctx, `
			INSERT INTO memories (
				memory_id, actor_id, dimension, namespace, content,
				tags, attributes, source_event_ids, reinforced_count,
				created_at, updated_at, embedding
			) VALUES ($1, $2, $3, $4, $5, $6, '{}', ARRAY[$7::uuid], 1, now(), now(), $8)
		`, id, "alice", item.dim, item.ns, item.content,
			tagsJSON, eventID, pgvector.NewVector(item.vec))
		if err != nil {
			_ = tx.Rollback()
			t.Fatalf("insert %s: %v", item.content, err)
		}
	}
	_ = tx.Commit()

	// Search using vec0 — item 0 should be the top hit.
	hits, err := s.SemanticSearch(ctx, SearchOpts{
		ActorID:        "alice",
		QueryEmbedding: vec0,
		Limit:          10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("expected at least one hit")
	}
	if hits[0].Content != "uses Go for backend services" {
		t.Errorf("expected top hit to be 'uses Go for backend services', got %q (similarity=%f)", hits[0].Content, hits[0].Similarity)
	}

	// Filter by dimension = preferences; should exclude the about item.
	prefHits, err := s.SemanticSearch(ctx, SearchOpts{
		ActorID:        "alice",
		QueryEmbedding: vec0,
		Dimensions:     []string{"preferences"},
		Limit:          10,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range prefHits {
		if h.Dimension != "preferences" {
			t.Errorf("dimension filter failed: got dimension=%s", h.Dimension)
		}
	}

	// Filter by tag "language" — only item 0 has it.
	tagHits, err := s.SemanticSearch(ctx, SearchOpts{
		ActorID:        "alice",
		QueryEmbedding: vec0,
		Tags:           []string{"language"},
		Limit:          10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tagHits) != 1 {
		t.Errorf("tag filter: want 1 hit, got %d", len(tagHits))
	}
}

func TestSemanticSearchMinSimilarity(t *testing.T) {
	dsn := startPG(t)
	s, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "bob"); err != nil {
		t.Fatal(err)
	}

	dim := 1536
	makeVec := func(seed float32) []float32 {
		v := make([]float32, dim)
		for i := range v {
			v[i] = seed
		}
		var norm float32
		for _, x := range v {
			norm += x * x
		}
		invNorm := float32(1.0)
		if norm > 0 {
			invNorm = 1.0 / norm
			z := invNorm / 2
			for i := 0; i < 6; i++ {
				z = (z + invNorm/z) / 2
			}
			invNorm = z
		}
		for i := range v {
			v[i] *= invNorm
		}
		return v
	}

	queryVec := makeVec(1.0)   // search vector
	closeVec := makeVec(0.99)  // very similar
	farVec := makeVec(-1.0)    // opposite direction — low/negative similarity

	eventID := uuid.New()
	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, item := range []struct {
		content string
		vec     []float32
	}{
		{"close item", closeVec},
		{"far item", farVec},
	} {
		id := uuid.New()
		tagsJSON := tagsToJSON([]string{"test"})
		_, err := tx.ExecContext(ctx, `
			INSERT INTO memories (
				memory_id, actor_id, dimension, namespace, content,
				tags, attributes, source_event_ids, reinforced_count,
				created_at, updated_at, embedding
			) VALUES ($1, $2, $3, $4, $5, $6, '{}', ARRAY[$7::uuid], 1, now(), now(), $8)
		`, id, "bob", "preferences", "/preferences/bob/", item.content,
			tagsJSON, eventID, pgvector.NewVector(item.vec))
		if err != nil {
			_ = tx.Rollback()
			t.Fatalf("insert %s: %v", item.content, err)
		}
	}
	_ = tx.Commit()

	// With a high MinSimilarity threshold, only the close item should be returned.
	// This verifies the filter is applied in SQL (not post-LIMIT in Go).
	hits, err := s.SemanticSearch(ctx, SearchOpts{
		ActorID:        "bob",
		QueryEmbedding: queryVec,
		MinSimilarity:  0.5,
		Limit:          10,
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, h := range hits {
		if h.Similarity < 0.5 {
			t.Errorf("got hit with similarity %f below threshold 0.5: %q", h.Similarity, h.Content)
		}
	}
	if len(hits) == 0 {
		t.Fatal("expected at least one hit above threshold")
	}
	// The close item should be present; the far item should not.
	foundClose := false
	for _, h := range hits {
		if h.Content == "close item" {
			foundClose = true
		}
		if h.Content == "far item" {
			t.Error("far item should have been filtered by MinSimilarity")
		}
	}
	if !foundClose {
		t.Error("close item should have been returned")
	}
}

func TestSemanticSearchEmptyEmbedding(t *testing.T) {
	dsn := startPG(t)
	s, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}

	_, err = s.SemanticSearch(context.Background(), SearchOpts{
		ActorID:        "alice",
		QueryEmbedding: nil,
	})
	if err == nil {
		t.Fatal("expected error for empty query embedding")
	}
}
