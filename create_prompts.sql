CREATE TABLE prompts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'user' | 'assistant'
    content       TEXT NOT NULL,
    tags          TEXT,                            -- simple comma-separated tags
    usage_count   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
