-- Per-actor task domain list. The classifier prompt is given this list, and
-- the parser sanitizes the LLM's output against it. 'general' is the
-- always-present fallback for anything outside the list; it must remain in
-- the array. Defaults match the historical hard-coded list.
ALTER TABLE actors
    ADD COLUMN task_domains jsonb NOT NULL
        DEFAULT '["coding","studying","meeting","general"]'::jsonb;
