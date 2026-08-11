ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_session_steps INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_session_cost NUMERIC(10,6);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_session_seconds INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS kill_switch_webhook_url TEXT;
CREATE TABLE IF NOT EXISTS session_halts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    reason TEXT NOT NULL,
    halted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, session_id)
);
