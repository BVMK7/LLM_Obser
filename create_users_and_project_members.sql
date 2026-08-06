-- Real user accounts + per-project membership/roles + invite links.
-- Before this, /projects* endpoints were entirely unauthenticated — anyone
-- could list/create/delete any project. This adds the account layer that
-- gates project MANAGEMENT (settings/team/api-keys/billing) behind a real
-- login. The existing per-project X-API-Key header (used by the SDK and
-- every /traces-style data-plane endpoint) is untouched by this migration.

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DB-backed opaque session token (hash-only-storage, same shape as
-- api_keys) — presented as "Authorization: Bearer <token>".
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

-- How a Project relates to a User. Two roles is enough for v1: admin
-- (rename/delete project, manage team/invites/api-keys/billing) and
-- viewer (read-only on the management surface).
CREATE TABLE project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);

-- v1 team invites are a copy/paste link (no email service in this app) —
-- token hashed like an API key, shown once at creation time.
CREATE TABLE project_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- Seed a dev user + admin membership on the fixed Default Project so local
-- dev / CI keep working with zero extra setup, same spirit as the seeded
-- dev API key in create_projects_and_api_keys.sql. Raw password is
-- "llmobs_dev_password" — bcrypt hash below (never used in prod).
INSERT INTO users (id, email, password_hash, name)
VALUES (
    '00000000-0000-0000-0000-0000000000f1',
    'dev@llmobs.local',
    '$2b$12$TijI.2SWGUZQpzYDVOgDZeWuEM7GZ.hEvNk/Rf24cWY3Vo5sU.38K',
    'Dev User'
);

INSERT INTO project_members (project_id, user_id, role)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000f1',
    'admin'
);
