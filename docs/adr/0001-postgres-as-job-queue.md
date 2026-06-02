# ADR 0001 — Postgres as the job queue

**Status:** Accepted. Hard to reverse (every store/queue interaction assumes
SQL semantics; flipping to a broker is a rewrite, not a swap).

## Decision

Run the job queue as a `jobs` table inside the same Postgres instance that
holds memories and events. Workers claim work with
`SELECT … FOR UPDATE SKIP LOCKED`, heartbeat via a `locked_at` column,
and a leader-elected reaper releases dead locks.

## Why

- **One state store, one backup story.** Memories, events, jobs, and queue
  state restore atomically from a single dump. With an external broker
  every restore has to reconcile two clocks.
- **Transactional ingest.** `POST /events` writes the event row and
  enqueues `extract_context` in the same transaction. Either both land or
  neither does — no orphan jobs, no lost events.
- **One VM deploy.** A typical deploy already runs one Postgres; adding
  Redis or RabbitMQ doubles the failure surface for a single-tenant
  side project.
- **SKIP LOCKED scales further than this workload needs.** At >100 RPS
  enqueue or a worker pool past ~32 we'd revisit; we are nowhere near.

## Rejected alternatives

- **Redis + a Streams-based consumer group.** Faster claim latency, but
  no transactional ingest and a second piece of infrastructure to back up,
  monitor, and restore.
- **RabbitMQ / SQS.** Operationally heavier; SQS adds an external
  dependency and a per-message billing tail that's wrong for personal use.
- **In-process channel queue.** Loses durability across restarts. We need
  `extract_context` jobs to survive a deploy.

## Cost of being wrong

If `SKIP LOCKED` contention ever becomes the bottleneck (it has not been
within ~3 orders of magnitude of current load), migrating to a broker
means: replicating the heartbeat/reaper contract, dual-writing during
cutover, and rewriting the `ClaimJob`/`CompleteJob`/`FailJob` triad.
Plan ~1 week. Not free, but bounded.
