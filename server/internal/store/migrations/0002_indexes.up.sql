CREATE INDEX events_actor_created_idx ON events (actor_id, created_at DESC);
CREATE INDEX events_meeting_idx ON events (actor_id, meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX events_attributes_gin ON events USING gin (attributes jsonb_path_ops);

CREATE INDEX memories_actor_dim_created_idx ON memories (actor_id, dimension, created_at DESC);
CREATE INDEX memories_actor_namespace_idx ON memories (actor_id, namespace);
CREATE INDEX memories_attributes_gin ON memories USING gin (attributes jsonb_path_ops);
CREATE INDEX memories_content_fts ON memories USING gin (to_tsvector('simple', content));

CREATE INDEX jobs_pending_idx ON jobs (run_after) WHERE state = 'pending';
CREATE INDEX jobs_state_idx ON jobs (state);
