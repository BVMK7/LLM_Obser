-- add_phase3_incidents.sql
-- AgentOps Phase 3: correlates AlertRule triggers, trace_flags, and
-- kill-switch SessionHalts into project+category-scoped incidents. See
-- docs/superpowers/specs/2026-08-13-aiops-incidents-design.md.

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('cost', 'reliability', 'performance', 'safety')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolved_note TEXT,
    recovery_suggestion TEXT,
    recovery_suggestion_json JSONB,
    recovery_generated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_open_lookup ON incidents(project_id, category, status) WHERE status != 'resolved';

CREATE TABLE IF NOT EXISTS incident_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('alert_rule', 'trace_flag', 'kill_switch')),
    source_id UUID NOT NULL,
    reason TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_signals_fingerprint ON incident_signals(fingerprint);
CREATE INDEX IF NOT EXISTS idx_incident_signals_incident_id ON incident_signals(incident_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS incident_webhook_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS incident_automation_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS last_incident_signal_at TIMESTAMPTZ;
