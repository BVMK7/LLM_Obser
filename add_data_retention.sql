-- add_data_retention.sql
-- Data retention & archival. See
-- docs/superpowers/specs/2026-08-18-data-retention-design.md.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_days INTEGER;

CREATE TABLE IF NOT EXISTS archived_traces (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    original_started_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archived_traces_project ON archived_traces(project_id, original_started_at);
