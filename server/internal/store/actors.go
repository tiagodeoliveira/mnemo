package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type Actor struct {
	ID              string
	DisplayName     string
	Email           sql.NullString
	Timezone        string
	DigestEnabled   bool
	CreatedAt       time.Time
	EpisodeStrategy string
	TTLOverrides    map[string]int // per-dimension TTL in days; 0 = never expires
}

func (s *Store) GetActor(ctx context.Context, id string) (*Actor, error) {
	var a Actor
	var ttlRaw []byte
	err := s.DB.QueryRowContext(ctx, `
		SELECT actor_id, display_name, email, timezone, digest_enabled, created_at,
		       episode_strategy, ttl_overrides
		FROM actors WHERE actor_id = $1
	`, id).Scan(&a.ID, &a.DisplayName, &a.Email, &a.Timezone, &a.DigestEnabled, &a.CreatedAt,
		&a.EpisodeStrategy, &ttlRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.TTLOverrides = make(map[string]int)
	if len(ttlRaw) > 0 {
		_ = json.Unmarshal(ttlRaw, &a.TTLOverrides)
	}
	return &a, nil
}

// UpsertActor inserts a new actor or returns the existing one. Display name
// defaults to the actor_id when inserting fresh.
func (s *Store) UpsertActor(ctx context.Context, id string) (*Actor, error) {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO actors (actor_id, display_name)
		VALUES ($1, $1)
		ON CONFLICT (actor_id) DO NOTHING
	`, id)
	if err != nil {
		return nil, err
	}
	return s.GetActor(ctx, id)
}
