CREATE TABLE IF NOT EXISTS trace_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('manual', 'anomaly', 'guardrail')),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_trace_flags_trace_id ON trace_flags(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_flags_open ON trace_flags(trace_id) WHERE resolved_at IS NULL;

ALTER TABLE spans ADD COLUMN IF NOT EXISTS failure_category TEXT;

CREATE TABLE IF NOT EXISTS policy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('blocked_model', 'max_cost_per_call', 'blocked_tool')),
    config JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policy_rules_project ON policy_rules(project_id, enabled);
