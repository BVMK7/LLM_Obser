-- add_otel_export.sql
-- OpenTelemetry export (push-only). A per-project opt-in collector URL
-- (NULL = disabled) plus a per-trace "already exported" marker, consumed
-- by a new 60s background loop — see main.py's
-- _run_otel_export_once/_otel_export_loop. This app never ingests OTLP;
-- it only POSTs to an external collector. See
-- docs/superpowers/specs/2026-08-25-otel-export-design.md.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS otel_collector_url TEXT;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS otel_exported_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_traces_otel_pending ON traces(project_id) WHERE otel_exported_at IS NULL;
