# ADR 0004 — OTLP/HTTP push for metrics, not Prometheus scrape

**Status:** Accepted. Reversible (the metrics surface is small enough to
re-export as a `/metrics` handler).

## Decision

Metrics are emitted through the OpenTelemetry SDK and pushed to a
collector via OTLP/HTTP. The server does not expose a Prometheus-format
`/metrics` endpoint.

## Why

- **No public scrape surface.** mnemo-server runs behind nginx with one
  hole (port 443 → `/`). A scrape endpoint would either need a second
  listener (more attack surface) or path-based routing (more nginx
  config to keep correct).
- **Push survives ephemeral containers.** If we ever scale workers
  horizontally with short-lived pods, scrape requires service discovery
  and a registry; push just works.
- **Single SDK for traces + metrics.** Spans and metrics share OTel
  resource attributes and the same exporter pipeline. Mixing
  Prometheus scrape with OTel traces means two libraries and two
  config blocks.
- **Consistency with sibling services.** Other services in the same
  deploy already push OTLP; matching that pattern means one collector,
  one config block, one operator runbook.

## Rejected alternatives

- **Prometheus scrape via `/metrics`.** Requires either a second port
  (firewall change) or nginx path-based exposure (and basic-auth to keep
  the endpoint private). Two extra moving pieces for parity with push.
- **Push to Prometheus Pushgateway.** Lossy semantics (last-write-wins
  per label set) and a deprecated path inside the Prometheus project.
- **statsd / DogStatsD.** No first-class trace integration, separate
  agent to run.

## Cost of being wrong

Adding a `/metrics` Prometheus endpoint alongside push is a one-file
add (`promhttp.Handler()`) that registers the same counters/histograms
through a dual exporter. Plan ~2 hours. Going the other way (removing
push to ship only Prometheus) is similar.
