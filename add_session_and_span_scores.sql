ALTER TABLE traces ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE INDEX IF NOT EXISTS idx_traces_session_id ON traces(session_id);
ALTER TABLE scores ADD COLUMN IF NOT EXISTS span_id UUID REFERENCES spans(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_scores_span_id ON scores(span_id);
