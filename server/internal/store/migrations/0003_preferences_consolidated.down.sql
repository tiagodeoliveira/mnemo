DROP INDEX IF EXISTS memories_consolidated_namespace_uq;

CREATE UNIQUE INDEX memories_consolidated_namespace_uq
    ON memories (actor_id, namespace)
    WHERE dimension IN ('about', 'project', 'task', 'daily_summary', 'meeting');
