# mnemo

A self-hosted personal AI memory system. Push conversation turns from any AI
tool (CLI, browser extension, voice transcription, etc.) and recall durable
context — preferences, project decisions, a living biographical profile,
per-meeting summaries, daily digests — through a small REST API that follows
you across sessions, workstations, and tools.

Built on Go and Postgres (with `pgvector` for semantic search). No managed
services, no Lambdas, no cloud vendor lock-in. Runs on one VM next to your
other side projects.

## How it works

`POST /events` writes a conversation slice (one or more turns plus metadata)
to a `memories_events` log row and enqueues an `extract_context` job. A worker
picks the job up, calls Claude in parallel for each dimension, and consolidates
the LLM's output against existing items via a diff contract (keep / reinforce /
update / delete / insert). Each surviving item is stored as its own row with
controlled-vocabulary tags, attributes, optional TTL, and an optional pgvector
embedding for semantic recall.

`GET /recall` returns items grouped by dimension. Each query parameter
(`?preferences=1&about=1&project=mnemo`) maps to a namespace prefix; the
handler queries each in parallel and merges the result. Passing `?q=<text>`
embeds the query once and ranks results within each requested dimension by
cosine similarity.

`POST /search` is the open-ended counterpart: embed a free-text query and
return the top-N items across all dimensions (optionally filtered by tag,
namespace prefix, time window, or minimum similarity).

A daily scheduler enqueues one `daily_digest` job per actor at their digest
hour. The handler reads that day's `daily_log` entries, calls Claude to
produce a structured summary (projects, decisions, learnings, time allocation,
blockers, carry-forward, reflection), writes it to
`/daily/{actor}/{YYYY-MM-DD}/summary/`, and — if SMTP is configured — emails it.

A meeting ends when a client sends an event with `attributes.meeting_ended=true`.
The `finalize_meeting` job concatenates all staged transcript chunks and
produces six per-meeting category items — summary, decisions, actions,
questions, highlights, followups — each at its own namespace.

### Memory dimensions

| Dimension       | Namespace                                                | What it captures                                                  |
|-----------------|----------------------------------------------------------|-------------------------------------------------------------------|
| preferences     | `/preferences/{actor}/`                                  | Coding style, tool choices, workflow habits                       |
| episodes        | `/episodes/{actor}/`                                     | Discrete events paired with the actor's reflection                |
| about           | `/about/{actor}/`                                        | Biographical profile (name, role, background, identity)           |
| project         | `/projects/{actor}/{projectName}/`                       | Architecture decisions, tech choices, ongoing project state       |
| task            | `/tasks/{actor}/{taskDomain}/`                           | Domain-specific insights (coding, studying, meeting, general)     |
| daily_log       | `/daily/{actor}/{YYYY-MM-DD}/log/`                       | Append-only activity entries throughout the day                   |
| daily_summary   | `/daily/{actor}/{YYYY-MM-DD}/summary/`                   | End-of-day structured digest, one row per day                     |
| meeting         | `/meetings/{actor}/{meetingId}/{category}/`              | Per-category meeting summary, six categories per meeting          |

All dimensions store one item per row. Consolidation runs after every write:
the LLM sees existing items + new candidates and emits a diff. Items have
per-dimension default TTLs (preferences ~365d, episodes ~180d, daily_log ~90d);
reinforcement bumps the expiry forward, consolidation deletes items the LLM
judges obsolete, and rows past `expires_at` are swept periodically.

## Architecture

```
┌──────────────────┐                  ┌─────────────────────────────┐
│  CLI / extension │  POST /events    │  Go server (mnemo-server)   │
│  auris / curl    │ ───────────────► │  • chi router               │
└──────────────────┘                  │  • Auth0 JWT verifier       │
                                       │  • worker pool (N workers)  │
                                       │  • leader-elected loops:    │
                                       │    digest_scheduler         │
                                       │    backfill_scheduler       │
                                       │    sweeper, reaper          │
                                       └────────────┬────────────────┘
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                          ▼                         ▼                         ▼
                  Postgres + pgvector       Anthropic API             OpenAI Embeddings
                  (jobs queue, memories,    (extract / consolidate    (text-embedding-3-small;
                   embeddings, events)       diffs, meeting summary,   pgvector HNSW index)
                                             daily digest)
```

State lives entirely in Postgres:
- `memories_events` — raw event log, one row per `POST /events`.
- `memories` — row per item with `tags`, `attributes`, `embedding`,
  `source_event_ids`, `reinforced_count`, `expires_at`.
- `jobs` — durable queue (`FOR UPDATE SKIP LOCKED`), retries with exponential
  backoff, dead-lettering after `MaxAttempts`. A boot-time `ReclaimStaleJobs`
  resets any `state='running'` row left over from a prior crash. A
  leader-elected reaper releases mid-flight locks whose worker died
  (90s threshold against a 30s heartbeat).

Multi-instance safe: schedulers acquire `pg_try_advisory_lock` on a dedicated
`*sql.Conn` and only one process runs each periodic task at a time. The
worker pool scales horizontally — every worker claims jobs through the same
SKIP LOCKED contention.

## Layout

```
server/      Go server (owns go.mod), Dockerfile, internal/ packages
cli/         TypeScript CLI (owns its tooling), Auth0 device-flow login
extension/   Chrome MV3 extension (plain JS, no build step)
scripts/     Smoke test
```

## Prerequisites

- Docker + Docker Compose
- Postgres 16 with `pgvector` (the `pgvector/pgvector:pg16` image in
  the compose files satisfies both)
- Go 1.26+ (only if running the server outside Docker)
- An Anthropic API key (extraction, consolidation, meeting summaries, digest)
- An OpenAI API key (embeddings — `text-embedding-3-small`, 1536 dims).
  Set `MNEMO_EMBED_DISABLED=1` if you don't want semantic recall.
- An Auth0 tenant for production. Local dev can set `MNEMO_AUTH_DISABLED=1`
  and bypass auth entirely.

## Quickstart (local dev)

```bash
git clone https://github.com/tiagodeoliveira/mnemo.git && cd mnemo
cp .env.example .env

# Postgres (pgvector image, port 5432)
docker compose up -d

# Server
cd server
go run ./cmd/mnemo-server
```

With the defaults in `.env.example`, the server runs with auth disabled
(every request maps to `dev-actor`), the LLM stubbed, and embeddings disabled
(`/search` returns 503). That's enough to exercise the API surface end-to-end
without spending API credits. To enable the real LLM, set `MNEMO_LLM_DISABLED=`
(empty) and `ANTHROPIC_API_KEY=sk-ant-…`. To enable semantic recall, set
`MNEMO_EMBED_DISABLED=` (empty) and `OPENAI_API_KEY=sk-…`.

A round-trip smoke test lives in `scripts/smoke.sh` — it boots the stack,
posts a synthetic conversation, waits for the extract job to drain, and
asserts that memories landed.

## Production deploy

The deployment stack — Postgres + mnemo-server + auris-server + nginx
(TLS terminator) + scheduled backups, all behind Cloudflare — lives in a
separate repo: [`kleos`](https://github.com/tiagodeoliveira/kleos). This
repo owns only the mnemo source and image; kleos owns the topology.

The server image is published to GHCR by the `release.yml` workflow on
every push to `main`. Kleos pulls and runs pinned tags. No deploy
artifacts (compose, env templates, cert handling) live here.

### Required environment

| Variable                    | Notes                                                                       |
|-----------------------------|-----------------------------------------------------------------------------|
| `DATABASE_URL`              | `postgres://user:pass@host:5432/db?sslmode=disable`                         |
| `MNEMO_PORT`                | Listen port (default `8080`)                                                |
| `MNEMO_WORKER_COUNT`        | Worker pool size (default `4`)                                              |
| `MNEMO_LLM_MAX_CONCURRENT`  | Anthropic concurrency throttle (default `4`). Avoids 529s on burst.         |
| `ANTHROPIC_API_KEY`         | Required unless `MNEMO_LLM_DISABLED=1`                                      |
| `MNEMO_LLM_MODEL`           | Default `claude-sonnet-4-6`                                                 |
| `OPENAI_API_KEY`            | Required unless `MNEMO_EMBED_DISABLED=1`                                    |
| `MNEMO_EMBED_MODEL`         | Default `text-embedding-3-small` (1536 dims)                                |
| `AUTH0_DOMAIN`              | `your-tenant.us.auth0.com`                                                  |
| `AUTH0_API_AUDIENCE`        | API identifier registered in Auth0; clients request tokens for this audience |
| `SMTP_HOST`/`USER`/`PASS`/`FROM` | Optional. If unset, daily digests skip the email send.                 |

## API reference

All requests except `GET /healthz` require an `Authorization: Bearer <jwt>`
header. The JWT must be signed by `AUTH0_DOMAIN` and request the
`AUTH0_API_AUDIENCE`. The token's `sub` (or `https://mnemo/actor_id`
custom claim) becomes the actor ID.

### `POST /events`

```json
{
  "session_id": "abc123",
  "source": "claude-code",
  "workstation": "macbook",
  "workdir": "/home/me/src/foo",
  "project": "foo",
  "turns": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "attributes": {
    "meeting_id": "m-42",
    "meeting_ended": true
  }
}
```

Returns `{"event_id": "..."}`. `session_id` and `turns` are required.
Consolidated items typically appear within ~5–30 s under normal load.
`attributes` is opaque metadata that's stored on the event and exposed to
the extractor; `meeting_id` + `meeting_ended` are interpreted as routing
hints into the meeting-finalize path.

### `GET /recall`

Select dimensions via query flags. None are returned by default — pick what
you want.

| Flag                | Returns                                              |
|---------------------|------------------------------------------------------|
| `?preferences=1`    | `/preferences/{actor}/`                              |
| `?episodes=1`       | `/episodes/{actor}/`                                 |
| `?about=1`          | `/about/{actor}/`                                    |
| `?project=foo`      | `/projects/{actor}/foo/`                             |
| `?task=coding`      | `/tasks/{actor}/coding/`                             |
| `?date=2026-05-14`  | `daily_log` + `daily_summary` for that date          |
| `?daily=1`          | shorthand for `?date=<today UTC>`                    |
| `?meeting=m-42`     | all six categories under `/meetings/{actor}/m-42/`   |
| `?q=<text>`         | embeds query once, reranks each dimension by cosine  |

Response shape: `{"<dim>": {"namespace": "...", "items": [{"id", "content", "tags", "similarity?", …}]}}`.

### `POST /search`

Open-ended semantic search across the actor's full memory.

```json
{
  "q": "what did I decide about kafka partitioning",
  "dimensions": ["project", "meeting"],
  "tags": ["architecture"],
  "tag_mode": "any",
  "namespace_prefix": "/projects/dev-actor/",
  "since": "2026-01-01",
  "until": "2026-12-31",
  "limit": 20,
  "min_similarity": 0.6
}
```

`q` is required. Returns `{"results": [...], "query_embedding_cost_tokens": N}`.
Returns `503` when `MNEMO_EMBED_DISABLED=1`.

### `GET /healthz`

Returns `200 ok` when the server can reach Postgres.

## Clients

- **`cli/`** — TypeScript CLI with an Auth0 device-flow login. Reads
  `~/.mnemo/config.json` for the cached token; `mnemo recall --project foo`
  prints the merged context.

  Install from a published release (tagged `v*`):

  ```bash
  npm install -g https://github.com/tiagodeoliveira/mnemo/releases/download/v0.1.0/mnemo-cli-0.1.0.tgz
  ```

  Or from source: `cd cli && npm ci && npm run build && npm link`.

- **`extension/`** — Chrome MV3 extension that intercepts SSE responses from
  `claude.ai` and `chatgpt.com`, tees the turns, and pushes them to `/events`.
  Same Auth0 token flow as the CLI. No build step — load `extension/` directly
  via `chrome://extensions → Load unpacked`.

- **Auris** — the voice-recording project (separate repo) pushes meeting
  transcripts to `/events` with `attributes.meeting_id` and finalizes via
  `meeting_ended=true`. Uses M2M client-credentials auth instead of device flow.

## Operational notes

**Queue resilience.** Three layers cooperate to keep the queue from
leaking locked rows:

1. *In-process retries.* `CompleteJob` and `FailJob` retry with exponential
   backoff (500ms / 1s / 2s) when the DB write itself fails. If they still
   fail, the worker logs an error and the lock falls through to layer 2.
2. *Continuous reaper.* A leader-elected goroutine runs `ReleaseStaleLocks`
   every 60s and resets any `state='running'` row whose `locked_at` is older
   than 90s back to `pending` (workers hold a 30s heartbeat).
3. *Boot reclaim.* At startup, `ReclaimStaleJobs` resets every `running`
   row to `pending` — safe because no worker can hold a lock before the
   pool starts.

**Multi-instance.** Run more than one `mnemo-server` against the same
Postgres if you need to. Schedulers (digest, backfill, sweeper, reaper)
use `pg_try_advisory_lock`; only one instance becomes leader per role and
the rest passively retry every 30s.

**Embeddings backfill.** New items get embedded inline at write time. If
the inline call fails the item lands with `embedding=NULL`; a leader-elected
scheduler runs `backfill_embeddings` every 5 minutes to populate missing
rows in batches. The pgvector HNSW index is built on `memories.embedding`.

## CI

- `test.yml` — `go test` for the server on every PR + push to `main` / `feat/**`,
  plus a `docker build` of the server image as a syntax check.
- `ci.yml` — runs inside `cli/`: lint, build, and (broken — see below) tests.
- `release.yml` — on push to `main` or a `v*` tag, builds and pushes the
  server image to GHCR. On `v*` tags only, also packs the CLI and attaches
  the `.tgz` to a GitHub Release.

A handful of CLI tests around mocked auth state are currently red and need a
separate cleanup; the build and lint passes are the green-bar gate.

## License

MIT — see `LICENSE`.
