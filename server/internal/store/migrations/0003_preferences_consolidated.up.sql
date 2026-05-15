-- Promote `preferences` from append (many rows per actor) to consolidated
-- (one row per actor, upserted with LLM-based freshness merging).
--
-- The partial unique index gates which dimensions are upsert-by-(actor_id,namespace).
-- We drop and recreate it because Postgres cannot ALTER a partial index's WHERE clause.
-- There's a brief moment without uniqueness enforcement — acceptable here because
-- there are no concurrent writers on a personal-scale deploy.

DROP INDEX IF EXISTS memories_consolidated_namespace_uq;

CREATE UNIQUE INDEX memories_consolidated_namespace_uq
    ON memories (actor_id, namespace)
    WHERE dimension IN ('about', 'project', 'task', 'daily_summary', 'meeting', 'preferences');
