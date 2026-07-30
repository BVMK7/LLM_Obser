CREATE TABLE traces (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    input         TEXT,
    output        TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ,
    total_tokens  INTEGER,
    cost          NUMERIC(10, 6)
);
