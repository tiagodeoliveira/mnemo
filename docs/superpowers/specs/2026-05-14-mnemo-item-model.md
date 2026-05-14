# mnemo memory item model — design

**Date:** 2026-05-14
**Branch:** `feat/go-server-rewrite` (to land before AWS cutover)
**Status:** Draft, pending implementation
**Supersedes:** sections of [`2026-05-13-mnemo-go-rewrite-design.md`](2026-05-13-mnemo-go-rewrite-design.md) describing the blob memory model.

## Summary

Replace the "one row per namespace, content is an LLM-managed markdown blob" model (current v1) with a "one row per memory ITEM, items have explicit metadata (tags, TTL, provenance)" model. The change targets the consolidated dimensions only — `daily_log`, `episodes`, `daily_summary`, and `meeting` are already item-shaped or naturally singular and stay as today.

Motivation: mnemo is designed as a memory service that could grow beyond a single user. The blob model is comfortable at personal scale but hard-blocks key product capabilities — hard TTL, tag-based filtering, per-item provenance, similarity search, granular delete. Doing the architecture work now, while there are no production users, is much cheaper than retrofitting after a year of accumulated data.

## Goals

1. Each consolidated memory becomes a **row per logical item** rather than a blob containing many items.
2. **Explicit per-item TTL** via `expires_at`, with per-dimension defaults and per-actor overrides.
3. **First-class tags** on every item (LLM-assigned during extraction, queryable at recall).
4. **Per-item provenance**: every event that touched an item is tracked in `source_event_ids text[]`.
5. **LLM consolidation contract becomes a diff** (keep / reinforce / delete / update / insert) rather than a blob rewrite. Auditable, validatable, reversible.
6. **Recall API returns items natively** with metadata. This is a breaking change from v1 (~17 hours of v1 lived) — the CLI and extension renderers update to display item lists rather than blobs.

## Non-goals (this spec)

- Vector similarity (`?q=` still ignored). Items have content but no embedding column yet. Schema is reserved for pgvector to slot in later.
- Cross-actor sharing or team memories.
- Memory linking / graph relationships.
- A UI / admin dashboard. Per-actor TTL overrides happen via SQL until a real management API exists.

## Schema

### `memories` (rewritten)

| Column             | Type        | Notes                                                                  |
|--------------------|-------------|------------------------------------------------------------------------|
| `memory_id`        | uuid PK     |                                                                        |
| `actor_id`         | text FK     |                                                                        |
| `dimension`        | text        | enum of 8 dimension names                                              |
| `namespace`        | text        | e.g. `/preferences/<actor>/`, `/projects/<actor>/<project>/`           |
| `content`          | text        | ONE statement / bullet / fact — not a blob                             |
| `tags`             | jsonb       | Array of strings: `["work", "deprecated", "language"]`. Default `[]`.  |
| `attributes`       | jsonb       | Existing `attr.*` filter target (unchanged from v1)                    |
| `source_event_ids` | uuid[]      | APPEND on every touch. Provenance trail.                               |
| `reinforced_count` | int         | Default `1`. Incremented when consolidation reinforces this item.      |
| `created_at`       | timestamptz | Default `now()`. Permanent — never updated.                            |
| `updated_at`       | timestamptz | Bumped on every reinforcement / update.                                |
| `expires_at`       | timestamptz | Nullable. Hard TTL. NULL = never expires.                              |

The **partial unique index on `(actor_id, namespace)`** for consolidated dimensions is **dropped**. Each namespace can have many rows.

### Indexes

```sql
CREATE INDEX memories_actor_dim_namespace_idx ON memories (actor_id, dimension, namespace);
CREATE INDEX memories_actor_updated_idx       ON memories (actor_id, updated_at DESC);
CREATE INDEX memories_expires_idx             ON memories (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX memories_tags_gin                ON memories USING gin (tags);
CREATE INDEX memories_attributes_gin          ON memories USING gin (attributes jsonb_path_ops);
CREATE INDEX memories_content_fts             ON memories USING gin (to_tsvector('simple', content));
```

### `actors` (additive)

```
| `ttl_overrides` | jsonb | Default `'{}'`. Per-dimension TTL in days, overriding the global defaults. E.g., `{"preferences": 730}`. |
```

### Default TTLs

Per-dimension defaults baked into the server (with per-actor override via `actors.ttl_overrides`):

| Dimension | Default TTL (days) | Rationale |
|---|---|---|
| `preferences` | 365 | Preferences evolve. ~1 year matches current freshness decay. |
| `about` | 0 (never) | Identity is durable. Stale facts are dropped on consolidation, not by TTL. |
| `project` | 0 (never) | Projects may go dormant but are worth keeping for context. |
| `task` | 365 | Task domains shift over time. |
| `daily_log` | 365 | A year of activity is plenty; older entries fade. |
| `episodes` | 0 (never) | Episodes are discrete historical moments. |
| `daily_summary` | 365 | Same rationale as daily_log. |
| `meeting` | 0 (never) | Meeting summaries are historical records. |

**Reinforcement extends `expires_at`.** When the LLM marks an item as reinforced (or when an `update` mutates it), `expires_at` is recomputed as `now() + default_ttl_for_dimension(or actor override)`. An item that's actively reinforced never expires; one mentioned once and forgotten decays after the window.

A background sweeper job (`expire_memories`) runs hourly and deletes rows where `expires_at < now() - interval '1 day'` (1-day grace period). Mirrors the existing `done` job sweeper.

## Consolidation contract

### v1 (blob model, current)

Input: existing blob + new content.
Output: rewritten blob.
LLM ergonomics: easy — "rewrite this document."
Failure mode: confused blob (graceful degradation).

### v2 (item model, this spec)

Input: existing items as a structured list + newly-extracted items.
Output: structured diff.
LLM ergonomics: more rigid — "return a JSON diff."
Failure mode: bad IDs → reject and retry. Wrong items deleted → real data loss.

### Diff format

The consolidation LLM call returns a JSON object:

```json
{
  "keep":      ["a1b2c3", "d4e5f6"],
  "reinforce": ["g7h8i9"],
  "delete":    ["j0k1l2"],
  "update":    [
    {"id": "m3n4o5", "content": "...", "tags": ["work", "language"]}
  ],
  "insert":    [
    {"content": "...", "tags": ["new-pref", "tool"]}
  ]
}
```

Semantics:
- **`keep`**: leave the item completely unchanged. `updated_at`/`expires_at` not bumped.
- **`reinforce`**: bump `updated_at` to now, bump `expires_at` to `now() + ttl`, increment `reinforced_count`, append the current event_id to `source_event_ids`. Content unchanged.
- **`delete`**: hard delete the row. Item is gone (no soft-delete tombstone in v2 — keep it simple).
- **`update`**: replace `content` and/or `tags`. Bump `updated_at`/`expires_at` as in reinforce. Append event_id to `source_event_ids`.
- **`insert`**: new row. `created_at = updated_at = now()`. `expires_at = now() + ttl`. `source_event_ids = [current_event_id]`. `reinforced_count = 1`.

### Validation

Before applying the diff:
1. Every ID in `keep`/`reinforce`/`delete`/`update` MUST exist in the input items.
2. No ID may appear in more than one of `keep`/`reinforce`/`delete`/`update`.
3. Every `insert` must have non-empty `content`.

On validation failure: log the error, retry once with a "your previous response had error X — return a corrected diff" prompt. On second failure: store the new extracted items as `insert`-only (skip the consolidation step entirely), surface a warning in `last_error`. The system continues to function; the merge quality is degraded that round.

### Truncation handling

If the consolidation LLM call hits `max_tokens`, return a `ConsolidationTruncatedError` and abort. Retry on next attempt. The handler does NOT apply a partial diff — all-or-nothing.

### LLM prompt shape

One prompt per dimension family:
- `SystemPreferencesItemConsolidate`
- `SystemAboutItemConsolidate`
- `SystemProjectItemConsolidate` (parametrized by project name)
- `SystemTaskItemConsolidate` (parametrized by task domain)

Each prompt includes:
- The dimension's role description
- Today's date
- The list of existing items (with id, created, updated, reinforced_count, content, tags)
- The newly-extracted items from this conversation
- The diff schema with examples
- Decay rule for this dimension (e.g., "items not reinforced in N days should be deleted")
- Format rule: "Each item is a single concise statement. Tags must be drawn from this controlled vocabulary: [...]"

The controlled-vocabulary tag list per dimension is intentional: it prevents tag-namespace explosion. Initial vocabularies:

- `preferences`: `language`, `tool`, `workflow`, `style`, `infrastructure`, `personal`
- `about`: `identity`, `role`, `location`, `background`, `expertise`, `current-work`
- `project`: `architecture`, `decision`, `constraint`, `tech-stack`, `status`
- `task`: `pattern`, `lesson`, `anti-pattern`, `convention`

The LLM can use any subset; operators can also assign tags manually via SQL.

## Recall API

### Response shape

`GET /recall?preferences=1&about=1` returns:

```json
{
  "dimensions": [
    {
      "dimension": "preferences",
      "namespace": "/preferences/<actor>/",
      "items": [
        {
          "id": "a1b2c3",
          "content": "uses Go for backend services",
          "tags": ["language", "tool"],
          "created_at": "2024-09-01T10:23:00Z",
          "updated_at": "2026-05-14T07:00:00Z",
          "expires_at": "2027-05-14T07:00:00Z",
          "reinforced_count": 12,
          "source_event_count": 12
        }
      ]
    },
    {
      "dimension": "about",
      "namespace": "/about/<actor>/",
      "items": [...]
    }
  ]
}
```

`source_event_ids` is NOT in the public response (privacy / footprint); `source_event_count` is the length of the array.

### Query parameters

| Param | Effect |
|---|---|
| `preferences=1`, `about=1`, etc. | Include this dimension in the response (as today) |
| `project=<name>`, `task=<domain>`, `meeting=<id>`, `date=<YYYY-MM-DD>` | Namespace selectors (as today) |
| `tags=<csv>` | Items must have AT LEAST ONE of the listed tags (OR semantics) |
| `tag_mode=all` | Switch tag filter to ALL of the listed tags (AND semantics) |
| `since=<YYYY-MM-DD>` | Items where `updated_at >= since` |
| `until=<YYYY-MM-DD>` | Items where `updated_at <= until` |
| `limit=<n>` | Cap items per dimension (default 100) |
| `visible=true/false` | Reserved for future "render as markdown" mode; in v2 unused — clients always get JSON |
| `q=<text>` | Reserved for future FTS / vector search; ignored today |

### Removed in v2

- The blob rendering (`visible=true` returning a markdown document). Clients render their own presentation from items.

### Backwards compatibility

**Not preserved.** The CLI and Chrome extension renderers must update to display item lists. Auris's mnemo recall client (`recaller.rs` in the auris repo) must update. This change is included in the cutover scope.

The CLI's `mnemo recall --preferences` should render as:

```
PREFERENCES (6 items)
  • uses Go for backend services
      tags: language, tool · reinforced 12× · since 2024-09-01
  • prefers rustacean style: small types, errors as values
      tags: style · reinforced 8× · since 2025-08-15
  ...
```

Operator-style by default; with `--format json` clients get the raw response.

## Tags

### Assignment
- **LLM-assigned during extraction**: each extracted item carries proposed tags from the dimension's controlled vocabulary. The consolidation prompt receives them and decides which to keep.
- **Operator-assigned via SQL**: standard `UPDATE memories SET tags = tags || '["deprecated"]'::jsonb WHERE memory_id = ...`. Out-of-band, no API yet.

### Vocabulary management

The controlled vocabulary lives in code, per dimension. Adding a new tag means a code change + prompt update. Trade-off: prevents tag explosion at the cost of agility. Reasonable for v1 of v2.

### Reserved tags

- `deprecated`: hide from default recall unless `?include_deprecated=1`. Set by the LLM when an item is being soft-superseded but not deleted (rare; usually the LLM should just `delete`).
- `archived`: same shape, different verb. For consciously-kept-but-not-relevant items.

## Migration plan

### Stage 1: Schema

One migration: `0005_item_model.up.sql`
- Drop the partial unique index `memories_consolidated_namespace_uq`
- Add columns: `tags jsonb DEFAULT '[]'`, `source_event_ids uuid[] DEFAULT '{}'`, `reinforced_count int DEFAULT 1`, `expires_at timestamptz`
- Add indexes per the schema section
- `actors`: add `ttl_overrides jsonb DEFAULT '{}'`

### Stage 2: Code

- Rewrite `consolidate.go`: new `ConsolidateItems()` function returns a diff struct. The existing `Consolidate()` and `ConsolidateFreshness()` are deprecated; keep them around briefly for non-item dimensions or just remove.
- Rewrite `extract/handler.go`: consolidation section calls `ConsolidateItems()`, applies diff via new store methods (`ApplyMemoryDiff()`).
- Add `store/memories_diff.go`: `ApplyMemoryDiff(ctx, tx, diff)` validates + applies in a single tx.
- Update `api/recall.go`: query items by namespace + filters, return new response shape.
- Rewrite `cli/src/commands/recall.ts` renderer for the item format.
- Rewrite `extension/background.js` recall handling.
- Update auris's `mnemo/recall.rs` to deserialize the new shape.

### Stage 3: Migrate existing data

One-shot script: `scripts/migrate-blobs-to-items.go`. For each blob row:
1. Read content
2. Call an LLM with a "split this consolidated memory into individual items, return JSON list of {content, tags}" prompt
3. Insert N item rows
4. Delete the blob row

For the dev DB this is throwaway (truncate works). If we deploy the v1 blob model first and then migrate, we run this script once on production data.

### Stage 4: Update smoke

The smoke must update to reflect:
- Single-row count assertions become per-namespace-item count assertions (e.g., "preferences has 6+ items" instead of "preferences has 1 row")
- The round-2 reinforcement check becomes "reinforced_count > 1 for these specific items"
- The round-2 contradiction check becomes "deleted_count > 0 OR the contradicted item is no longer in recall"

## Open decisions (need confirmation before implementation)

1. **TTL: hard delete vs. soft tombstone?**
   - Spec proposes hard delete. Simpler, no orphaned rows.
   - Alternative: `deleted_at timestamptz` and filter `WHERE deleted_at IS NULL` in recall.
   - Recommendation: hard delete.

2. **Diff format: include `tags` in `reinforce`?**
   - Spec excludes — `reinforce` is "this item is still true, dates only." Tags don't change.
   - If tags need to evolve, use `update` instead of `reinforce`.

3. **What happens when a `reinforce` ID's source extraction didn't reinforce that item — i.e., the LLM is just confused?**
   - We can't really know. Trust the LLM's diff. Worst case is a slightly-too-fresh `expires_at`.

4. **Per-actor TTL override schema**:
   - Spec: `actors.ttl_overrides` is `jsonb` mapping dimension name → days. `{"preferences": 730}` overrides global default. `0` = never expires.
   - Alternative: separate `actor_ttl_settings` table. Cleaner but adds a join on every insert.
   - Recommendation: jsonb on actors.

## Test plan

### Unit
- `store/memories_diff.go`: ApplyMemoryDiff with valid diff, with overlapping sets (rejects), with non-existent IDs (rejects), with empty insert content (skips).
- `extract/consolidate.go`: ConsolidateItems happy path with stub LLM returning a valid diff. Truncation case.
- `api/recall.go`: response shape, tag filters (OR + AND mode), since/until, limit.

### Integration (existing `internal/integration/e2e_test.go`)
- Update to assert item-shape responses
- Add a round-2 case that verifies items are reinforced (not duplicated) on repeated extraction

### Smoke (`scripts/smoke.sh`)
- Round 1 assertions update from "X rows" to "X items per dimension"
- Round 2 assertions: reinforced items have `reinforced_count > 1`, new items present, deleted contradictions absent (where the LLM cooperates)
- New: TTL assertion — manually backdate an item's `created_at` past the dimension's default TTL, run reinforcement event for OTHER items, verify the stale item gets deleted on the next consolidation OR by the sweeper

## Backwards-incompatible changes

These ship together in the cutover:

1. `/recall` response shape (dimensions of items, not blob content)
2. CLI `mnemo recall --preferences` output format (rendered item list)
3. Chrome extension popup display (item list)
4. Auris `mnemo::recall` Rust deserialization
5. Smoke script expectations
6. Existing dev-database memory rows (truncated; data is throwaway)

All clients land in lockstep with the server change. Since no production users exist yet, this is a same-day coordinated rollout, not a rolling migration.

## Effort estimate

- Schema + migration: 0.5 day
- consolidate.go rewrite + new diff prompts: 1 day
- handler.go rewrite: 0.5 day
- store/memories_diff.go + tests: 0.5 day
- api/recall.go rewrite: 0.5 day
- CLI renderer + extension + auris updates: 1 day
- Smoke + integration test updates: 0.5 day
- Migration script for existing blob data: 0.5 day (or skip if we agree dev data is throwaway)

Total: **~5 focused days** of work.

## Risks

| Risk | Mitigation |
|---|---|
| LLM returns invalid diffs frequently | Validation + one retry; fall back to insert-only on second failure. Surface in `jobs.last_error` for inspection. |
| Diff-based consolidation loses subtle merges the blob model handled well | Hold the smoke as the bar; round-2 checks (single-row → fixed-item-count, with reinforcement counts) catch regressions. |
| Items proliferate without bound when the LLM keeps `insert`-ing instead of `reinforce`-ing | TTL + per-actor recall limits cap blast radius. Sweeper deletes stale items. If proliferation persists, tighten the consolidation prompt's "prefer reinforce over insert" guidance. |
| Tag vocabulary becomes the wrong shape and a forced refactor later | Vocabulary is in code; rename + migration script is mechanical. The risk is low because vocabulary is short. |

## What's NOT in scope here (explicit non-coverage)

- Vector / similarity search
- Memory linking ("this fact references that one")
- Compression of older items into a summary row (mnemo's own "compaction")
- Per-item ACLs / sharing
- API for tag/TTL management (operator uses SQL until needed)
- Soft-delete with restore

These all become viable AFTER the item model lands and the schema is right.
