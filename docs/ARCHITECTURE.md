# Architecture

How a single `POST /events` becomes a durable, tagged, embedded, reinforceable
row in `memories` — and how a gazillion of those rows, written from a dozen
sources over months, stay coherent. This is the technical narrative the
README points to: every hop the data takes, why each hop exists, and what
would break if it didn't.

The system has one job: turn unstructured conversation into structured,
queryable memory. Everything else is plumbing in service of that loop.

## Cast of characters

Five primitives carry the whole journey. Keep these in your head.

| Primitive       | Lives in                | What it is                                                          |
|-----------------|-------------------------|---------------------------------------------------------------------|
| **Event**       | `memories_events` row   | A raw conversation slice — turns, source, project, attributes       |
| **Job**         | `jobs` row              | A unit of work pulled by a worker. Durable, retried, dead-lettered  |
| **Dimension**   | `memories.dimension`    | The kind of memory (`preferences`, `about`, `project`, `task`, …)   |
| **Namespace**   | `memories.namespace`    | Where the memory lives in the per-actor hierarchy                   |
| **Memory item** | `memories` row          | One durable fact: content + tags + embedding + provenance + TTL     |

Everything below describes how events transit through jobs to become items,
keyed by dimension, slotted into namespaces, and kept honest.

## Act I — The event lands

Any client (CLI, browser extension, voice transcriber, curl) opens a TLS
connection, attaches an Auth0-issued JWT, and posts to `/events`. The
server doesn't care which client. The shape is identical.

```json
{
  "session_id": "abc123",
  "source": "claude-code",
  "project": "mnemo",
  "workdir": "/home/me/src/mnemo",
  "turns": [
    {"role": "user",      "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "attributes": { "meeting_id": "design", "meeting_ended": false }
}
```

`session_id` and `turns` are the only required fields. Everything else is
metadata that downstream extractors may use — `project` routes into the
project dimension, `attributes.meeting_id` flips a row into the meeting
finalize path, and so on.

Three things happen inside the same Postgres transaction:

1. The actor ID is taken from the JWT (`sub` or a custom claim) and used
   to insert one row into `memories_events`. Turns must be a JSON array;
   anything else is rejected as `400 ErrBadTurns` at the store boundary,
   not at the API boundary, so the rule holds for every caller path.
2. An `extract_context` job is enqueued referencing the new `event_id`.
   The payload is a two-field JSON object: `{actor_id, event_id}`. No
   conversation content travels in the queue — the worker re-reads the
   event row.
3. If `attributes.meeting_ended=true` and `meeting_id` is set, a second
   job (`finalize_meeting`) is enqueued in the same tx. Meetings are
   handled by their own path; see Act IV.

Tx commits. The handler returns `202 Accepted` with the event ID. From the
client's perspective, the call is done. The actual extraction has not
started yet — and may not for hundreds of milliseconds, depending on
worker contention.

```
client ──► POST /events ──► tx { insert event; enqueue extract_context }  ──► 202
                                                            │
                                                            ▼
                                                    jobs.state='pending'
```

This shape — synchronous insert, asynchronous extraction — is deliberate.
The LLM calls take seconds; the client should not wait for them. If a job
fails mid-flight, it retries with exponential backoff (Act V). If it
fails permanently, it dead-letters. Either way the event row stays put as
the authoritative source of truth.

## Act II — A worker claims the job

`mnemo-server` runs a worker pool sized by `MNEMO_WORKER_COUNT` (default
4). Each worker is a goroutine in a `for { select }` loop that
periodically calls `ClaimJob` against the same Postgres:

```sql
SELECT * FROM jobs
 WHERE state='pending' AND run_after <= now()
 ORDER BY job_id
 FOR UPDATE SKIP LOCKED
 LIMIT 1
```

`SKIP LOCKED` is what makes the queue multi-instance safe without an
external broker. N workers across M `mnemo-server` instances all hammer
this query; each gets a different row, never the same one. The worker
flips `state='running'`, records `locked_by` (a worker ID) and
`locked_at`, and dispatches to the handler registered for the job kind:

| Job kind                | Handler                      | What it does                                         |
|-------------------------|------------------------------|------------------------------------------------------|
| `extract_context`       | `extract.Handler.Handle`     | Turn one event into memory items across dimensions   |
| `finalize_meeting`      | `meeting.Handler.Handle`     | Concatenate transcript chunks, emit category items   |
| `daily_digest`          | `digest.Handler.Handle`      | Build end-of-day summary, optionally email it        |
| `backfill_embeddings`   | `queue.BackfillEmbeddings…`  | Embed rows where `embedding IS NULL`                 |

For most events, the rest of the story is the extract path.

## Act III — Extraction

`extract.Handler.Handle` loads the event row plus the actor record, then
fans out **four LLM calls in parallel** under an `errgroup`. Each call
targets one extractor prompt. The prompts are small, single-purpose, and
optimized for different output shapes — there is no monolithic "extract
everything" prompt, because asking a model to do four jobs at once
produces measurably worse results than asking it to do one job four times.

```
                          ┌─► classifier ─► TASK / PROJECT_FACTS / TASK_FACTS / DAILY
                          │
event.turns ─► extract  ──┼─► about       ─► ABOUT: lines
                          │
                          ├─► preferences ─► {"preferences": [...]}
                          │
                          └─► episodes    ─► {"episodes": [{event, reflection}]}
```

### The four extractors

**Classifier** is the most ambitious. One prompt produces four fields:
the task domain (`coding`, `studying`, `meeting`, `general`, or
`unknown`), project facts ("things only true for this codebase"), task
facts ("things true for any project in this domain"), and a daily log
paragraph. Output is a custom format with line headers, parsed with
regular expressions. JSON would be nicer here, but the headered format
survives LLM truncation better — if `DAILY:` is cut off, we still
extracted the project facts above it.

**About** is the biographical extractor with strict attribution rules.
First-person user turns are trusted; assistant turns are trusted only
when they're responding to material the user supplied (a resume, a bio).
Output is `ABOUT:\n<one fact per line>`, line-parsed. The strictness
matters: an LLM that's helping the user write a CV will happily
hallucinate facts about them if you let it.

**Preferences** is the JSON extractor for durable workflow choices —
"prefers tabs", "uses Go for backend services". The prompt is short and
firm about format: `{"preferences": [...]}`. Empty array is a valid
outcome. Most short events extract nothing here; that's correct.

**Episodes** is the structured-event extractor: a pair of `{event,
reflection}` strings per discrete thing the user described and reflected
on. Most conversations produce zero episodes. The signal is reflective
content — "I tried X and learned Y" — not commit-log noise.

### When the LLM disobeys

The extractor prompts all end with `Output JSON only.` Models comply
about 99% of the time. The remaining 1% wraps the JSON in prose:
*"Here are the preferences: {...}"*. `strictUnmarshal` handles this by
first attempting a direct decode, then falling back to a substring scan
between the first `{` and the last `}` (or `[`/`]` for top-level arrays).
If even that fails — pure prose, no JSON — the parse function returns an
error, the handler logs a warning, and the affected dimension is treated
as if it extracted nothing. The other three dimensions proceed
unaffected. **One flaky LLM response never blocks the rest of the
extraction.** This is asymmetric on purpose: a missed extraction is
recoverable on the next event; a failed job that retries forever is not.

### From candidates to NewItems

The four parallel calls produce per-dimension candidate lists. The
handler reshapes them into the common `NewItem{Content, Tags}` form,
then decides which dimensions are non-empty:

- `projectItems` only if the event carried a `project` field AND the
  classifier emitted `PROJECT_FACTS`.
- `taskItems` only if the classifier picked a non-`unknown` domain AND
  emitted `TASK_FACTS`.
- `aboutItems` only if the about-extractor emitted at least one fact.
- `prefItems` only if the preferences extractor emitted at least one.

A dimension with no candidates is skipped entirely — no LLM consolidation
call, no row touch. This is the first cost discipline of the pipeline:
**we don't pay for a consolidation pass when there's nothing to
consolidate.**

## Act IV — Consolidation

For each non-empty dimension, the handler runs a **second** LLM call:
consolidation. This is the step that distinguishes mnemo from a chat-log
dump. The model sees:

- The existing items in the target namespace, formatted with ordinal
  refs (`ref: 1`, `ref: 2`, …) instead of UUIDs.
- The freshly-extracted candidates.
- A controlled tag vocabulary specific to this dimension.

It emits a diff:

```json
{
  "keep":      ["1", "3"],
  "reinforce": ["2"],
  "delete":    ["4"],
  "update":    [{"id": "5", "content": "...", "tags": ["..."]}],
  "insert":    [{"content": "...", "tags": ["..."]}]
}
```

Five operations, one for every transition an item can undergo:

| Op           | Semantics                                                                       |
|--------------|---------------------------------------------------------------------------------|
| **keep**     | Item unchanged — content, tags, dates, expiry all untouched                     |
| **reinforce**| Item is still true — bump `reinforced_count`, `updated_at`, and `expires_at`    |
| **update**   | Item is refined — rewrite content/tags, keep the same row ID and provenance     |
| **delete**   | Item is wrong or superseded — hard delete                                       |
| **insert**   | Brand-new fact — new row, new ID, new provenance                                |

The prompt enforces one rule with teeth: **every existing item must
appear in exactly one of keep / reinforce / update / delete**. Items the
LLM omits are not implicitly kept. This forces the model to make a
deliberate decision per item on every pass, which is the only way to get
delete to ever fire on something that's no longer true. If you let
"omitted" mean "keep," stale memories accumulate forever.

### Refs, not UUIDs

The LLM sees ordinal refs (`1`, `2`, `3`) instead of canonical UUIDs.
Claude and GPT both routinely corrupt 36-character UUIDs — drop a hex
digit, miss a hyphen — and a corrupted ID can't be matched to anything.
Single-digit refs are nearly impossible to typo, cost ~30 fewer tokens
per item, and the parser maintains a `refs[ord] → uuid.UUID` map so the
diff is translated back at the application boundary.

The parser also accepts bare numbers (`1` vs `"1"`) because the model
sometimes emits JSON numbers despite the schema saying strings.
Defensive parsing beats prompt fragility.

### Degraded fallback

If the consolidation LLM returns unparseable JSON or hits `max_tokens`
mid-response, the consolidator does **not** fail the job. It logs a
warning and falls back to an insert-only diff: every new candidate gets
inserted, no existing items are touched. The resulting state has some
duplication but is correct. The next consolidation pass on this
dimension (next event) will see the duplicates and clean them up via
delete/update. Graceful degradation beats hard failure when the failure
mode is recoverable on the next tick.

### Per-dimension tag vocabularies

Tags are not free-form. Each consolidator carries a closed vocabulary
the LLM must pick from:

| Dimension     | Vocabulary                                                            |
|---------------|-----------------------------------------------------------------------|
| preferences   | `language, tool, workflow, style, infrastructure, personal`           |
| about         | `identity, role, location, background, expertise, current-work`      |
| project       | `architecture, decision, constraint, tech-stack, status`             |
| task          | `pattern, lesson, anti-pattern, convention`                          |

Closed vocabularies give two things: indexable tag-AND / tag-OR queries
that mean the same thing in March and August, and a faceted recall UX
that doesn't degrade into "thousand-tag soup." Without them, the LLM
would invent tags forever — `golang`, `go-lang`, `Go`, `GoLang`, ad
nauseam — and search would silently drift.

## Act V — Application

The consolidation diff is now a `MemoryDiff{Keep, Reinforce, Update,
Delete, Insert}` struct in Go. Applying it is where Postgres earns its
salary.

`ApplyMemoryDiff` opens a transaction, **re-queries** the existing
namespace under `FOR UPDATE`, builds a `validIDs` set, and then resolves
the diff. Resolution exists because LLMs do three things you have to
defend against:

1. **Overlap.** An item appears in both `keep` and `delete`. The
   resolver applies a precedence ladder — `delete > update > reinforce >
   keep` — and drops the lower-precedence membership.
2. **Hallucination.** The LLM names a ref that wasn't in the existing
   set. The resolver drops it.
3. **Empty inserts.** An insert with whitespace-only content. Dropped.

Resolution emits a `ResolveReport` that logs counts. A non-empty report
is a signal of prompt degradation, not a failure.

After resolution:

- **keep** is a no-op. The row already exists; nothing changes.
- **reinforce** runs `UPDATE … SET reinforced_count = reinforced_count
  + 1, updated_at = now(), expires_at = now()+TTL,
  source_event_ids = array_append(source_event_ids, $event_id)`. This
  is the heartbeat that keeps a still-true memory from aging out, and
  it's also how provenance accumulates — every reinforcement appends
  the event that re-witnessed the fact.
- **update** rewrites `content` and `tags`, optionally updates the
  embedding (the handler pre-computes embeddings for inserts and
  updates before opening the tx), bumps `updated_at`/`expires_at`, and
  appends to `source_event_ids`. The row ID is preserved, so back-refs
  from search results stay stable.
- **delete** is `DELETE FROM memories WHERE memory_id=$1`. Hard delete.
  Foreign keys do not reference `memories`, so this is safe.
- **insert** allocates a new UUID, writes the new row with
  `source_event_ids=ARRAY[$event_id]` and `reinforced_count=1`,
  `expires_at` derived from the dimension's TTL.

All within one tx. The tx wraps every dimension's diff for the same
event — if project consolidation succeeds but task consolidation fails,
nothing commits. Either the event produced a consistent multi-dimension
update or none.

### Embeddings: inline with backfill safety net

Insert and update operations carry an `Embedding []float32` field. The
extract handler pre-computes embeddings via OpenAI's
`text-embedding-3-small` (1536 dims) **before** opening the tx, in a
single batched call. If that fails — network blip, rate limit, key
revoked — the handler logs and proceeds with `embedding=NULL`. A
leader-elected `backfill_embeddings` scheduler runs every 5 minutes,
sweeps rows where `embedding IS NULL`, and fills them in batches.

The HNSW index on `memories.embedding` makes cosine-similarity ORDER BY
cheap. Without the inline path, every recall would lag behind writes by
up to 5 minutes; without the backfill, transient OpenAI failures would
permanently degrade search.

## Namespace routing

Namespaces are the partition key inside `memories`. Every item carries
one — a path-shaped string that puts it in exactly one bucket per
actor. The handler picks the namespace at consolidation time, based on
dimension and event metadata:

| Dimension       | Namespace template                              | Source of the slug                          |
|-----------------|-------------------------------------------------|---------------------------------------------|
| preferences     | `/preferences/{actor}/`                         | actor only — one bucket per actor           |
| about           | `/about/{actor}/`                               | actor only                                  |
| project         | `/projects/{actor}/{projectName}/`              | `event.project` field                       |
| task            | `/tasks/{actor}/{taskDomain}/`                  | classifier output (one of allowed domains)  |
| daily_log       | `/daily/{actor}/{YYYY-MM-DD}/log/`              | `event.created_at` in UTC                   |
| daily_summary   | `/daily/{actor}/{YYYY-MM-DD}/summary/`          | the digest job's target date                |
| episodes (flat) | `/episodes/{actor}/`                            | actor only                                  |
| episodes (mo.)  | `/episodes/{actor}/{YYYY-MM}/`                  | per-actor `episode_strategy` setting        |
| meeting         | `/meetings/{actor}/{meetingId}/{category}/`     | event's `meeting_id`; one of six categories |

Two design points worth pulling out:

**Project namespace is opt-in.** If an event doesn't carry a `project`
field, project consolidation never runs for that event. The same is
true for task — `unknown` domain → skip. A noisy chat about general
topics doesn't pollute every project's memory.

**Day buckets vs. flat buckets.** `daily_log` is per-day because the
daily-digest scheduler queries one day at a time. `episodes` defaults to
flat but switches to monthly buckets when the actor opts in
(`episode_strategy='monthly_bucket'`) — useful when episodes accumulate
into the thousands and the model context window starts to strain.

The consolidation diff only operates within a single namespace. Items
from two namespaces are never mixed in one diff, even if they share an
actor and dimension. This is what makes it safe to consolidate two
projects in parallel without coordinating.

## Provenance

`memories.source_event_ids uuid[]` is the audit trail. Every insert
seeds it with one event ID; every reinforce and every update appends
the current event ID. The array grows monotonically over the item's
lifetime.

This shape has two consequences worth knowing:

**Provenance is a constant-time read.** "Show me the conversations that
contributed to this memory" doesn't need a join table — it's the array
itself, length N for a memory reinforced N times. Loading and rendering
that list is one indexed lookup per event ID.

**Events outlive their direct purpose but not forever.** The
`memories_events` table is not swept. Each event row stays in the
database as long as any memory references it. A future cleanup may
truncate ancient events whose memories have themselves been deleted —
but as of today, the events log is durable history. The query path
("which sessions taught me this?") is the reason; the secondary reason
is debuggability when extraction goes wrong.

A few specifics from `ApplyMemoryDiff`:

```go
// reinforce
UPDATE memories
   SET reinforced_count = reinforced_count + 1,
       updated_at       = $2,
       expires_at       = $3,
       source_event_ids = array_append(source_event_ids, $4::uuid)
 WHERE memory_id = $1
```

```go
// insert
INSERT INTO memories (..., source_event_ids, reinforced_count, ...)
VALUES (..., ARRAY[$source_event_id::uuid], 1, ...)
```

`reinforced_count` and `len(source_event_ids)` will track each other in
the steady state, but they can diverge when an LLM update emits a new
content under an existing ID — the count bumps, the array gets the new
event ID, the row is now a different fact wearing the same memory_id.
This is fine. The fact "this row has been touched N times by these N
events" is the invariant; the prior content lives only in the LLM's
prompt history.

## TTL, expiry, and the sweeper

Every consolidation pass writes `expires_at` based on dimension defaults
(with per-actor overrides):

| Dimension       | Default TTL (days) | Decay model                                  |
|-----------------|--------------------|----------------------------------------------|
| preferences     | 365                | Decays unless reinforced                     |
| about           | 0 (never)          | Identity facts only drop on contradiction    |
| project         | 0 (never)          | Project decisions only drop on supersession  |
| task            | 365                | Task patterns decay unless reinforced        |
| daily_log       | 365                | Long-tail audit history                      |
| episodes        | 0 (never)          | Episodes are landmarks; they don't expire    |
| daily_summary   | 365                | Digest summaries decay                       |
| meeting         | 0 (never)          | Meeting outputs are landmark records         |

Reinforcement is the heartbeat: every time an item is re-witnessed by a
new event, `expires_at` rolls forward another TTL window. Items the LLM
judges obsolete are deleted by consolidation. Items that simply age out
(no reinforcement, no delete) are removed by the sweeper, which runs as
a leader-elected loop and deletes rows where `expires_at < now()`.

The two mechanisms are complementary. Consolidation deletes facts that
the model judges wrong — "the user used to prefer X, but now they
prefer Y." The sweeper deletes facts that have simply gone silent — no
one mentioned them, the model didn't see them often enough to bump
their freshness, time passed. Both are needed; either alone produces a
memory that either over-prunes (too much LLM trust) or under-prunes (no
forgetting curve).

## Meetings and digests: parallel handlers

`extract_context` is one of four job kinds. Two more deserve a paragraph.

**`finalize_meeting`** is enqueued when an event carries
`attributes.meeting_ended=true`. The handler concatenates every event
in `memories_events` matching `meeting_id`, runs a meeting-summary
prompt that emits six categories (summary, decisions, actions,
questions, highlights, followups), and writes one row per non-empty
category into `/meetings/{actor}/{meetingId}/{category}/`. Meetings
don't go through the consolidation diff path — each meeting writes a
fresh set of category rows tied to its event. Re-ingesting the same
meeting_id (e.g., a corrected transcript) would produce a second set;
deduplication on meetings is a future concern, not a current one.

**`daily_digest`** is enqueued by the digest scheduler — a
leader-elected loop that wakes at the actor's preferred digest hour
(per-actor timezone), checks whether a digest already ran today, and
enqueues if not. The handler reads that day's `daily_log` rows, asks
the LLM to produce a structured summary across seven sections
(projects, decisions, learnings, time allocation, blockers,
carry-forward, reflection), writes it to
`/daily/{actor}/{YYYY-MM-DD}/summary/`, and — if SMTP is configured —
emails it. Like meeting, digest writes new rows rather than diffing
existing ones; the YYYY-MM-DD slug makes each day its own bucket.

## Recall — the inverse path

The journey we just traced is for writes. Reads come back through two
endpoints, both stateless.

**`GET /recall?preferences=1&project=mnemo`** maps each query flag to a
namespace prefix and runs a parallel fan-out: one query per requested
dimension, each scoped to the actor and namespace. When `?q=<text>` is
also present, the server embeds the query once, joins it as an
`ORDER BY embedding <=> $1` clause on each per-dimension query, and
returns items ranked by cosine similarity. Errors from individual
dimensions are collected indexed-by-i and yield a 500 — no partial
success on recall.

**`POST /search`** is the open-ended counterpart: embed the query once,
filter by optional tags / namespace prefix / date range / similarity
threshold, and rank across the actor's entire memory. The dimension
filter is optional; without it, search returns top-N across everything
the actor owns.

Recall is where the journey's investments pay back. The closed tag
vocabulary makes faceted filters meaningful. The per-namespace
partitioning makes scoped queries fast. The reinforced_count and
updated_at columns let recall prefer fresh, reinforced facts when ties
arise. The pgvector HNSW index makes semantic search a single ANN
lookup instead of a full scan. And `source_event_ids` lets the UI
("where did I learn this?") link any result back to its origin events.

## Resilience: what happens when the wheels come off

The journey above describes the happy path. The unhappy paths are
what make this system multi-instance safe in production.

**Worker crashes mid-job.** The job row is left at `state='running'`
with `locked_by` and `locked_at` set. A leader-elected reaper runs every
60 seconds and resets any `running` row whose `locked_at` is older than
90 seconds (workers heartbeat every 30s) back to `pending`. Another
worker picks it up. The previous attempt is counted; after
`MaxAttempts` the job dead-letters with `state='failed'` and the last
error stored in `last_error`.

**Server crashes mid-job.** Same situation, plus a boot-time
`ReclaimStaleJobs` that resets every `running` row to `pending` —
because no worker can possibly hold a lock before the pool starts.

**LLM provider goes down.** A configurable provider chain — Anthropic
primary, OpenAI fallback — guards the LLM client behind a circuit
breaker (`MNEMO_LLM_BREAKER_THRESHOLD`,
`MNEMO_LLM_BREAKER_COOLDOWN_S`). After N consecutive failures the
breaker trips, traffic routes to the next provider, and a cooldown
expires before the primary is retried. The chain's clients have
matching `Model` strings, so the consolidation prompt doesn't need to
know which provider answered.

**Embedding provider goes down.** Inline embedding fails, items land
with `embedding=NULL`, the backfill scheduler tops them up later. No
job fails for embedding reasons; only LLM failures do.

**Two `mnemo-server` instances.** Schedulers (digest, backfill,
sweeper, reaper) hold a `pg_try_advisory_lock` on a dedicated
`*sql.Conn`; only one instance becomes leader per role. Workers
contend through `SKIP LOCKED` and naturally distribute. Add a third
instance and nothing changes about the contract.

## A worked example

Suppose the user posts a single conversation about debugging a Postgres
query under project `mnemo`. The chain of effects:

1. `POST /events` writes one `memories_events` row, enqueues an
   `extract_context` job. Returns 202.
2. A worker claims the job. `extract.Handler.Handle` opens four
   parallel LLM calls. The classifier returns:
   - `TASK: coding`
   - `PROJECT_FACTS:\nmnemo uses pgvector HNSW indexes for cosine ANN.`
   - `TASK_FACTS:\nUse EXPLAIN ANALYZE before guessing about query plans.`
   - `DAILY:\nWorked on debugging a slow ANN query in mnemo...`
   The preferences extractor returns `{"preferences": []}`. The
   about extractor returns `ABOUT:\nNONE`. The episodes extractor
   returns `{"episodes": []}`.
3. Two dimensions have candidates: project (1 item) and task (1 item).
4. Project consolidation runs in namespace `/projects/{actor}/mnemo/`.
   The LLM sees 14 existing project items + the new candidate, emits a
   diff with `reinforce: ["7"]` (an existing item that already said
   "uses pgvector for ANN") and no inserts. The diff is applied;
   item 7's `reinforced_count` becomes 4, `expires_at` rolls forward,
   `source_event_ids` appends the new event ID.
5. Task consolidation runs in namespace `/tasks/{actor}/coding/`. The
   LLM sees 30 existing task items + the new candidate, emits
   `insert: [{content: "Use EXPLAIN ANALYZE...", tags: ["pattern"]}]`.
   The new row is inserted with a fresh embedding.
6. The daily log line is also written, to `/daily/{actor}/{today}/log/`.
7. The job commits `state='done'`.

Three rows touched, two of them updates and one an insert, across two
namespaces, all tagged from controlled vocabularies, all with embeddings,
all traceable back to one event. A week later, when the user posts a
similar conversation, item 7 will be reinforced again — and the pattern
about EXPLAIN ANALYZE, if reinforced enough, may get updated or deleted
depending on whether the next conversation refines or contradicts it.

The journey ends where it began: with one event row, durable and
unchanged, and a memory shape that reflects everything the user has
ever told the system about themselves and their work — pruned,
reinforced, reranked, but never lost in the gazillion.
