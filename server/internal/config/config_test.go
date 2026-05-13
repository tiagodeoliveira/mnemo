package config

import (
	"testing"
)

func TestLoadRequiresAuth0(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "")
	if _, err := Load(); err == nil {
		t.Fatalf("expected error when auth enabled without Auth0 vars")
	}
}

func TestLoadAuthDisabled(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !c.AuthDisabled {
		t.Fatalf("AuthDisabled not set")
	}
}
