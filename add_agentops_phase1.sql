CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, slug)
);

ALTER TABLE traces ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_traces_agent_id ON traces(agent_id);

CREATE TABLE IF NOT EXISTS agent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    session_id UUID,
    scope TEXT NOT NULL CHECK (scope IN ('short_term', 'long_term')),
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_lookup ON agent_memory(project_id, agent_id, session_id, scope);
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires_at ON agent_memory(expires_at) WHERE expires_at IS NOT NULL;
-- Real upsert race-safety: Postgres treats NULL as distinct-from-itself in
-- a plain UNIQUE constraint, so agent_id/session_id (both nullable) can't
-- be part of one directly — COALESCE to a sentinel UUID inside the index
-- expression instead, so two concurrent writers of the same logical key
-- (including "no agent"/"no session") actually collide and one gets a real
-- IntegrityError, which the app catches and re-reads (see main.py's
-- write_memory). The stored columns stay NULL; only the index expression
-- normalizes them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_memory_key ON agent_memory (
    project_id,
    COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scope,
    key
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    session_id UUID,
    content JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox ON agent_messages(project_id, to_agent_id, read_at);
