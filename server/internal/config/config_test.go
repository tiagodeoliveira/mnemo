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
	t.Setenv("MNEMO_LLM_DISABLED", "1")
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
	t.Setenv("MNEMO_LLM_DISABLED", "1")
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !c.EmbedDisabled {
		t.Fatalf("EmbedDisabled not set")
	}
}

func TestLoadRequiresAnthropicKeyForAnthropicProvider(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	t.Setenv("MNEMO_EMBED_DISABLED", "1")
	t.Setenv("MNEMO_LLM_DISABLED", "")
	t.Setenv("MNEMO_LLM_PROVIDERS", "anthropic")
	t.Setenv("ANTHROPIC_API_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when anthropic listed without ANTHROPIC_API_KEY")
	}
}

func TestLoadRejectsUnknownProvider(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	t.Setenv("MNEMO_EMBED_DISABLED", "1")
	t.Setenv("MNEMO_LLM_DISABLED", "")
	t.Setenv("MNEMO_LLM_PROVIDERS", "gemini")
	t.Setenv("ANTHROPIC_API_KEY", "x")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for unknown provider")
	}
}

func TestLoadChainOK(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	t.Setenv("MNEMO_EMBED_DISABLED", "1")
	t.Setenv("MNEMO_LLM_DISABLED", "")
	t.Setenv("MNEMO_LLM_PROVIDERS", "anthropic,openai")
	t.Setenv("ANTHROPIC_API_KEY", "a")
	t.Setenv("OPENAI_API_KEY", "o")
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(c.LLMProviders) != 2 || c.LLMProviders[0] != "anthropic" || c.LLMProviders[1] != "openai" {
		t.Fatalf("providers: %+v", c.LLMProviders)
	}
}
