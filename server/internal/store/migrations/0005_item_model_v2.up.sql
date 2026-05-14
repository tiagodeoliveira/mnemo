-- v2 item-model schema. Adds pgvector, reshapes memories into row-per-item.
-- The existing v1 blob rows continue to exist; this migration only ADDS
-- columns and indexes. Stage 2 will start writing the new shape.

CREATE EXTENSION IF NOT EXISTS vector;

-- Drop the v1 partial unique index. v2 allows many rows per namespace.
DROP INDEX IF EXISTS memories_consolidated_namespace_uq;

-- New columns on memories.
ALTER TABLE memories
    ADD COLUMN tags             jsonb       NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN source_event_ids uuid[]      NOT NULL DEFAULT '{}',
    ADD COLUMN reinforced_count int         NOT NULL DEFAULT 1,
    ADD COLUMN expires_at       timestamptz,
    ADD COLUMN embedding        vector(1536);

-- New indexes for v2 query patterns.
CREATE INDEX memories_actor_updated_idx ON memories (actor_id, updated_at DESC);
CREATE INDEX memories_expires_idx       ON memories (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX memories_tags_gin          ON memories USING gin (tags);
-- The existing memories_attributes_gin from migration 0002 is still good.
-- The existing memories_content_fts from migration 0002 is still good.
-- HNSW index for cosine-similarity ORDER BY.
CREATE INDEX memories_embedding_hnsw    ON memories USING hnsw (embedding vector_cosine_ops);

-- Per-actor TTL overrides. JSON object mapping dimension name → days.
ALTER TABLE actors
    ADD COLUMN ttl_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
