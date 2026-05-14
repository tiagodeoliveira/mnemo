-- Reverses 0005. Note: data in the new columns is lost when this runs.

ALTER TABLE actors
    DROP COLUMN IF EXISTS ttl_overrides;

DROP INDEX IF EXISTS memories_embedding_hnsw;
DROP INDEX IF EXISTS memories_tags_gin;
DROP INDEX IF EXISTS memories_expires_idx;
DROP INDEX IF EXISTS memories_actor_updated_idx;

ALTER TABLE memories
    DROP COLUMN IF EXISTS embedding,
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS reinforced_count,
    DROP COLUMN IF EXISTS source_event_ids,
    DROP COLUMN IF EXISTS tags;

-- Recreate the v1 partial unique index so down + up cycles stay safe.
CREATE UNIQUE INDEX memories_consolidated_namespace_uq
    ON memories (actor_id, namespace)
    WHERE dimension IN ('about', 'project', 'task', 'daily_summary', 'meeting', 'preferences');

-- We intentionally do NOT drop the vector extension on down — it might be
-- used by other databases on the same Postgres instance. Keep the extension
-- around; only the table column references are removed.
