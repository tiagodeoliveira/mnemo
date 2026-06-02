# ADR 0003 — Multi-provider LLM chain with per-provider circuit breaker

**Status:** Accepted. Reversible (single-provider operation is the default
when `MNEMO_LLM_PROVIDERS=anthropic`).

## Decision

LLM calls go through a `Chain` that walks a configurable provider list in
order. Each provider has its own circuit breaker keyed by name
(`llm.anthropic`, `llm.openai`). Failure trips the breaker for that
provider only; subsequent calls in the same request skip the open
provider and try the next.

- Default chain: `MNEMO_LLM_PROVIDERS=anthropic` (single provider, fallback
  disabled).
- Recommended production chain: `anthropic,openai`.
- Breaker thresholds: 5 consecutive failures → open for 60s, then probe.

## Why

- **Anthropic 529 storms.** Real outages return 5xx for minutes; without
  failover, extract jobs pile up and exhaust retry budget.
- **No error classification table.** Failing over on a permanent error
  wastes at most one call. Maintaining a transient-vs-permanent table is
  ongoing prompt-and-API maintenance for marginal benefit.
- **Per-provider isolation.** A degraded Anthropic shouldn't open the
  OpenAI breaker too — they fail independently. A single shared breaker
  would conflate them.
- **Same-model assumption is wrong.** Each provider needs its own model
  string (`claude-sonnet-4-6` vs `gpt-4o-mini`), which is why the env
  vars split into `MNEMO_ANTHROPIC_MODEL` and `MNEMO_OPENAI_MODEL`.

## Rejected alternatives

- **Single provider with aggressive retries.** Sustained outages still
  fail the whole pipeline; retries are pure latency cost.
- **Round-robin load-balance between providers.** Different prompt
  fidelity per provider — Claude consolidation diffs are noticeably
  cleaner than GPT-4o-mini's. Pinning primary preserves quality;
  fallback is degraded-mode, not steady-state.
- **Error-classification routing (5xx → fail-over, 4xx → fail-hard).**
  Adds a table to maintain per provider; the breaker bounds the waste
  of being wrong.

## Cost of being wrong

Falling back to single-provider operation is a one-env-var flip
(`MNEMO_LLM_PROVIDERS=anthropic`). Adding a third provider (Bedrock,
Azure OpenAI) is a ~100-line implementation against the existing
`Provider` interface.
