package config

import (
	"fmt"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	DatabaseURL string `env:"DATABASE_URL,required"`
	Port        string `env:"MNEMO_PORT" envDefault:"8080"`
	WorkerCount int    `env:"MNEMO_WORKER_COUNT" envDefault:"4"`

	AuthDisabled  bool   `env:"MNEMO_AUTH_DISABLED"`
	Auth0Domain   string `env:"AUTH0_DOMAIN"`
	Auth0Audience string `env:"AUTH0_API_AUDIENCE"`

	LLMDisabled     bool   `env:"MNEMO_LLM_DISABLED"`
	AnthropicAPIKey string `env:"ANTHROPIC_API_KEY"`
	AnthropicModel  string `env:"MNEMO_ANTHROPIC_MODEL" envDefault:"claude-sonnet-4-6"`
	OpenAIModel     string `env:"MNEMO_OPENAI_MODEL" envDefault:"gpt-4o-mini"`
	// xAI (Grok) and Gemini are reached through their OpenAI-compatible
	// endpoints, so they only need a key and a model string here; the client
	// wiring lives in buildLLMProviders.
	XAIAPIKey        string `env:"XAI_API_KEY"`
	XAIModel         string `env:"MNEMO_XAI_MODEL" envDefault:"grok-4-1-fast-reasoning"`
	GeminiAPIKey     string `env:"GEMINI_API_KEY"`
	GeminiModel      string `env:"MNEMO_GEMINI_MODEL" envDefault:"gemini-2.5-flash"`
	LLMMaxConcurrent int    `env:"MNEMO_LLM_MAX_CONCURRENT" envDefault:"4"`
	// LLMProviders is the failover order. The first provider in the list is
	// primary; subsequent ones are tried in order when the primary's breaker
	// trips or each call errors. Default keeps single-provider behavior.
	LLMProviders []string `env:"MNEMO_LLM_PROVIDERS" envSeparator:"," envDefault:"anthropic"`
	// LLMBreakerThreshold and LLMBreakerCooldown tune the per-provider circuit
	// breaker inside the chain. 5 consecutive failures over a 60s window is
	// the empirical sweet spot — long enough to ride out Anthropic 529 bursts,
	// short enough to swap to OpenAI on a real outage.
	LLMBreakerThreshold int `env:"MNEMO_LLM_BREAKER_THRESHOLD" envDefault:"5"`
	LLMBreakerCooldownS int `env:"MNEMO_LLM_BREAKER_COOLDOWN_SECONDS" envDefault:"60"`

	// WorkerBreakerThreshold and WorkerBreakerCooldownS tune the per-job-kind
	// circuit breaker inside the queue pool. Defaults mirror the LLM breaker;
	// async jobs share the same "5 failures in a row" failure mode (a broken
	// extractor, a runaway store error) and the same cooldown shape — when
	// the breaker is open, jobs of that kind are rescheduled rather than
	// retried hot.
	WorkerBreakerThreshold int `env:"MNEMO_WORKER_BREAKER_THRESHOLD" envDefault:"5"`
	WorkerBreakerCooldownS int `env:"MNEMO_WORKER_BREAKER_COOLDOWN_SECONDS" envDefault:"60"`

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
	if !c.LLMDisabled {
		for _, p := range c.LLMProviders {
			switch p {
			case "anthropic":
				if c.AnthropicAPIKey == "" {
					return c, fmt.Errorf("config: anthropic in MNEMO_LLM_PROVIDERS requires ANTHROPIC_API_KEY")
				}
			case "openai":
				if c.OpenAIAPIKey == "" {
					return c, fmt.Errorf("config: openai in MNEMO_LLM_PROVIDERS requires OPENAI_API_KEY")
				}
			case "xai":
				if c.XAIAPIKey == "" {
					return c, fmt.Errorf("config: xai in MNEMO_LLM_PROVIDERS requires XAI_API_KEY")
				}
			case "gemini":
				if c.GeminiAPIKey == "" {
					return c, fmt.Errorf("config: gemini in MNEMO_LLM_PROVIDERS requires GEMINI_API_KEY")
				}
			default:
				return c, fmt.Errorf("config: unknown LLM provider %q (supported: anthropic, openai, xai, gemini)", p)
			}
		}
	}
	return c, nil
}
