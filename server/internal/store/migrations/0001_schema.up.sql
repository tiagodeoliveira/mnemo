CREATE TABLE actors (
    actor_id        text PRIMARY KEY,
    display_name    text NOT NULL,
    email           text,
    timezone        text NOT NULL DEFAULT 'UTC',
    digest_enabled  boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
    event_id        uuid PRIMARY KEY,
    actor_id        text NOT NULL REFERENCES actors(actor_id),
    session_id      text NOT NULL,
    project         text,
    source          text,
    workstation     text,
    workdir         text,
    turns           jsonb NOT NULL,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    meeting_id      text,
    meeting_ended   boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
    memory_id       uuid PRIMARY KEY,
    actor_id        text NOT NULL REFERENCES actors(actor_id),
    dimension       text NOT NULL,
    namespace       text NOT NULL,
    content         text NOT NULL,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_event_id uuid REFERENCES events(event_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Partial unique constraint: only one row per namespace for consolidated dimensions.
CREATE UNIQUE INDEX memories_consolidated_namespace_uq
    ON memories (actor_id, namespace)
    WHERE dimension IN ('about', 'project', 'task', 'daily_summary', 'meeting');

CREATE TABLE jobs (
    job_id          bigserial PRIMARY KEY,
    kind            text NOT NULL,
    payload         jsonb NOT NULL,
    state           text NOT NULL DEFAULT 'pending',
    attempts        int  NOT NULL DEFAULT 0,
    last_error      text,
    run_after       timestamptz NOT NULL DEFAULT now(),
    locked_by       text,
    locked_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);
