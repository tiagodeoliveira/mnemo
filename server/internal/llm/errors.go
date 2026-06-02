package llm

import "fmt"

// APIError is returned by provider Complete() implementations on a non-2xx
// HTTP response. It preserves the status code so wrappers (metrics, the
// chain) can classify a failure — e.g. 429 → rate_limited — via errors.As
// instead of string-matching the message. The Error() string is unchanged
// from the previous fmt.Errorf form ("<provider>: status <n>: <body>") so
// logs read identically.
type APIError struct {
	Provider   string // "openai" | "anthropic"
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s: status %d: %s", e.Provider, e.StatusCode, e.Body)
}
