CREATE TABLE spans (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id           UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    step_name          TEXT NOT NULL,
    input              TEXT,
    output             TEXT,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at           TIMESTAMPTZ,
    error              TEXT,  -- raw error message, if this step failed
    error_explanation  TEXT   -- plain-language explanation of `error`, generated automatically
);

CREATE INDEX idx_spans_trace_id ON spans(trace_id);
