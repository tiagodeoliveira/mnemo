package config

import (
	"testing"
)

func TestLoadRequiresAuth0(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "")
	t.Setenv("MNEMO_EMBED_DISABLED", "1")
	if _, err := Load(); err == nil {
		t.Fatalf("expected error when auth enabled without Auth0 vars")
	}
}

func TestLoadAuthDisabled(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	t.Setenv("MNEMO_EMBED_DISABLED", "1")
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !c.AuthDisabled {
		t.Fatalf("AuthDisabled not set")
	}
}

func TestLoadRequiresOpenAIKey(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	t.Setenv("MNEMO_EMBED_DISABLED", "")
	t.Setenv("OPENAI_API_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatalf("expected error when embed enabled without OPENAI_API_KEY")
	}
}

func TestLoadEmbedDisabled(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	t.Setenv("MNEMO_EMBED_DISABLED", "1")
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !c.EmbedDisabled {
		t.Fatalf("EmbedDisabled not set")
	}
}
