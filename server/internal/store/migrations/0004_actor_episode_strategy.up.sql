ALTER TABLE actors
    ADD COLUMN episode_strategy text NOT NULL DEFAULT 'monthly_bucket'
        CHECK (episode_strategy IN ('flat', 'monthly_bucket', 'disabled'));
