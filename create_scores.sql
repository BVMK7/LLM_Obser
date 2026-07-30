CREATE TABLE scores (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id      UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    score_name    TEXT NOT NULL,      -- e.g. "relevance", "accuracy"
    score_value   NUMERIC NOT NULL,   -- e.g. 0-1 or 0-100, depending on score_name
    explanation   TEXT,               -- why the score was given
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scores_trace_id ON scores(trace_id);
