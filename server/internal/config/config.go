package config

import (
	"fmt"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	DatabaseURL     string `env:"DATABASE_URL,required"`
	Port            string `env:"MNEMO_PORT" envDefault:"8080"`
	WorkerCount     int    `env:"MNEMO_WORKER_COUNT" envDefault:"4"`

	AuthDisabled  bool   `env:"MNEMO_AUTH_DISABLED"`
	Auth0Domain   string `env:"AUTH0_DOMAIN"`
	Auth0Audience string `env:"AUTH0_API_AUDIENCE"`

	LLMDisabled      bool   `env:"MNEMO_LLM_DISABLED"`
	AnthropicAPIKey  string `env:"ANTHROPIC_API_KEY"`
	LLMModel         string `env:"MNEMO_LLM_MODEL" envDefault:"claude-sonnet-4-6"`
	LLMMaxConcurrent int    `env:"MNEMO_LLM_MAX_CONCURRENT" envDefault:"4"`

	EmbedDisabled bool   `env:"MNEMO_EMBED_DISABLED"`
	EmbedModel    string `env:"MNEMO_EMBED_MODEL" envDefault:"text-embedding-3-small"`
	OpenAIAPIKey  string `env:"OPENAI_API_KEY"`

	SMTPHost string `env:"SMTP_HOST"`
	SMTPUser string `env:"SMTP_USER"`
	SMTPPass string `env:"SMTP_PASS"`
	SMTPFrom string `env:"SMTP_FROM"`
}

func Load() (Config, error) {
	var c Config
	if err := env.Parse(&c); err != nil {
		return c, fmt.Errorf("config: %w", err)
	}
	if !c.AuthDisabled {
		if c.Auth0Domain == "" || c.Auth0Audience == "" {
			return c, fmt.Errorf("config: AUTH0_DOMAIN and AUTH0_API_AUDIENCE required when auth enabled")
		}
	}
	if !c.EmbedDisabled && c.OpenAIAPIKey == "" {
		return c, fmt.Errorf("config: OPENAI_API_KEY required when MNEMO_EMBED_DISABLED is not set")
	}
	return c, nil
}
