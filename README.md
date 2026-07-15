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

`POST /events` logs a conversation slice and enqueues an extraction job. A
worker pool runs Claude prompts in parallel, consolidates the output against
existing items via a diff contract, and writes rows with tags, attributes,
optional TTL, and an optional pgvector embedding. `GET /recall` and
`POST /search` read those rows back — grouped by dimension or ranked by
cosine similarity. A daily scheduler emits one summary per actor per day; a
meeting finalizer produces six per-meeting category items.

For the full data journey — extractors, consolidation refs, namespace
routing, TTL/sweep, recall ranking — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

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

# Postgres (pgvector image, host port 55432 by default — see docker-compose.yml)
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

This repo owns only the mnemo source and image. Deploy topology —
Postgres, a TLS terminator, scheduled backups, secrets management —
lives in whatever stack you run it in. The server image is published
to GHCR by the `release.yml` workflow on every push to `main`; pin a
SHA or tag in your compose / Helm / whatever.

### Required environment

| Variable                    | Notes                                                                       |
|-----------------------------|-----------------------------------------------------------------------------|
| `DATABASE_URL`              | `postgres://user:pass@host:5432/db?sslmode=disable` (local dev exposes Postgres on host port `55432`; container-internal is still 5432) |
| `MNEMO_PORT`                | Listen port (default `18080` for local dev)                                 |
| `MNEMO_WORKER_COUNT`        | Worker pool size (default `4`)                                              |
| `MNEMO_LLM_MAX_CONCURRENT`  | Per-provider concurrency throttle (default `4`). Avoids 529s on burst.      |
| `MNEMO_LLM_PROVIDERS`       | Failover chain, comma-separated. First is primary. Default `anthropic`. Supported: `anthropic`, `openai`. |
| `ANTHROPIC_API_KEY`         | Required when `anthropic` is in `MNEMO_LLM_PROVIDERS`                       |
| `MNEMO_ANTHROPIC_MODEL`     | Default `claude-sonnet-4-6`                                                 |
| `MNEMO_OPENAI_MODEL`        | Default `gpt-4o-mini`                                                       |
| `MNEMO_LLM_BREAKER_THRESHOLD` | Consecutive failures before a provider's breaker opens (default `5`).     |
| `MNEMO_LLM_BREAKER_COOLDOWN_SECONDS` | Cooldown before breaker probes again (default `60`).               |
| `MNEMO_WORKER_BREAKER_THRESHOLD`     | Per-job-kind breaker threshold in the worker pool (default `5`).   |
| `MNEMO_WORKER_BREAKER_COOLDOWN_SECONDS` | Per-job-kind breaker cooldown (default `60`).                   |
| `OPENAI_API_KEY`            | Required unless `MNEMO_EMBED_DISABLED=1` (or when `openai` is in `MNEMO_LLM_PROVIDERS`) |
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
  npm install -g https://github.com/tiagodeoliveira/mnemo/releases/download/v0.2.0/mnemo-cli-0.2.0.tgz
  ```

  Or from source: `cd cli && npm ci && npm run build && npm link`.

  The CLI package also ships **`mnemo-mcp`**, a stdio MCP server for agents.
  It uses the same `~/.mnemo/config.json` and cached login as `mnemo`:

  ```json
  {
    "mcpServers": {
      "mnemo": { "command": "mnemo-mcp" }
    }
  }
  ```

  Tools exposed: `recall_memories`, `search_memories`, `push_event`,
  `bootstrap_document`, and `get_profile`.

- **`extension/`** — Chrome MV3 extension that intercepts SSE responses from
  `claude.ai` and `chatgpt.com`, tees the turns, and pushes them to `/events`.
  Same Auth0 token flow as the CLI. No build step — load `extension/` directly
  via `chrome://extensions → Load unpacked`.

- **Voice / meeting recorders** — any client can push meeting transcripts
  to `/events` with `attributes.meeting_id` and finalize the meeting via
  `meeting_ended=true`. Server-side jobs use M2M client-credentials auth
  instead of the device flow.

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
- `ci.yml` — runs inside `cli/`: lint, build, and `vitest` tests.
- `release.yml` — on push to `main` or a `v*` tag, builds and pushes the
  server image to GHCR. On `v*` tags only, also packs the CLI and attaches
  the `.tgz` to a GitHub Release.

## License

MIT — see `LICENSE`.
