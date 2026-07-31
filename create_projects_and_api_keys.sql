-- Multi-tenancy: every customer is a Project, authenticated via an ApiKey.
-- Existing rows (single-tenant local dev data) are backfilled into a fixed
-- "Default Project" with a known, clearly-marked dev-only API key, so the
-- existing local frontend/CI flow keeps working with zero extra setup —
-- real customers get their own project + freshly random key via POST /projects.

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

-- Fixed id so this migration is safely re-describable/idempotent-by-intent
-- across environments (local dev machine, CI's throwaway Postgres).
INSERT INTO projects (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Project');

-- Raw key value is "llmobs_dev_default_do_not_use_in_prod" — sha256 below.
-- Prefix stored in the clear so the UI can show "llmobs_dev_d..." without
-- ever needing to re-display (or re-derive) the full secret.
INSERT INTO api_keys (project_id, key_hash, key_prefix)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '933a9276c0e72bb047e8d07b5b1da02df05e0075bb5ae7e9ba2f3f8dba42b7d3',
    'llmobs_dev_d'
);

ALTER TABLE traces ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE datasets ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE prompts ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE scorers ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE experiments ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE alert_rules ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE traces SET project_id = '00000000-0000-0000-0000-000000000001' WHERE project_id IS NULL;
UPDATE datasets SET project_id = '00000000-0000-0000-0000-000000000001' WHERE project_id IS NULL;
UPDATE prompts SET project_id = '00000000-0000-0000-0000-000000000001' WHERE project_id IS NULL;
UPDATE scorers SET project_id = '00000000-0000-0000-0000-000000000001' WHERE project_id IS NULL;
UPDATE experiments SET project_id = '00000000-0000-0000-0000-000000000001' WHERE project_id IS NULL;
UPDATE alert_rules SET project_id = '00000000-0000-0000-0000-000000000001' WHERE project_id IS NULL;

ALTER TABLE traces ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE datasets ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE prompts ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE scorers ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE experiments ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE alert_rules ALTER COLUMN project_id SET NOT NULL;

-- scorers.slug was globally unique; two different customers should each be
-- able to have their own "correctness" scorer without colliding.
ALTER TABLE scorers DROP CONSTRAINT IF EXISTS scorers_slug_key;
ALTER TABLE scorers ADD CONSTRAINT uq_scorers_project_slug UNIQUE (project_id, slug);
