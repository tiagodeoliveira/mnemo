# ADR 0002 — Diff-based consolidation with ordinal refs

**Status:** Accepted. Reversible (the prompt + parser can be swapped without
touching the storage layer).

## Decision

Consolidation prompts feed the LLM **existing items + new candidates** and
expect a structured diff back:
`{ keep, reinforce, update, delete, insert }`. Existing items are passed
with **ordinal refs** (`"1"`, `"2"`, …) rather than canonical UUIDs; the
parser translates refs back to UUIDs via a side map.

The diff is then applied transactionally in `ApplyMemoryDiff`. An overlap
auto-resolver handles self-contradictory diffs (e.g. same ID in both
`keep` and `update`) and logs the resolution rather than failing.

## Why

- **Bounded token cost.** Full re-write asks the LLM to regurgitate every
  surviving fact verbatim — quadratic in collection size and a constant
  source of paraphrase drift.
- **Provenance preservation.** `reinforce` bumps `reinforced_count` and
  freshens `expires_at` without altering content; `update` changes
  content but preserves the row's `id`, tags history, and provenance.
- **Ordinal refs survive LLM corruption.** 36-character UUIDs reliably
  get mangled (one digit flipped, hyphens dropped). Single-digit refs
  do not. The translation table is short and the substitution is
  unambiguous.
- **Auto-resolver tolerates LLM disobedience.** Rather than fail the
  whole consolidation when the diff contradicts itself, the resolver
  picks a precedence order (delete > update > reinforce > keep) and
  surfaces the count via a WARN log for observability.

## Rejected alternatives

- **Full overwrite per dimension.** Token-heavy, paraphrase-prone, loses
  per-row provenance.
- **UUIDs in the wire format.** Demonstrably corrupted by Claude and
  GPT-4o-mini in production; cost a week of debugging before the switch
  to ordinal refs.
- **Strict-fail on diff overlap.** Drops too many otherwise-recoverable
  consolidations on the floor.

## Cost of being wrong

The prompt and parser are isolated to `extract/prompts.go` +
`extract/parse.go` + `store/memories_diff.go`. Swapping to a different
contract (e.g. JSON Patch RFC 6902) is a focused 1–2 day change.
