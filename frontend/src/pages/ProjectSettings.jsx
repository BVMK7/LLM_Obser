import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import CopyButton from "../components/CopyButton";
import {
  getProjects,
  renameProject,
  getMembers,
  updateMemberRole,
  removeMember,
  getInvites,
  createInvite,
  revokeInvite,
  getApiKeys,
  createApiKey,
  revokeApiKey,
} from "../api";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function ProjectSettings() {
  const { id } = useParams();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [newInviteLink, setNewInviteLink] = useState(null);
  const [newApiKey, setNewApiKey] = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [error, setError] = useState(null);

  const myMembership = members.find((m) => m.user_id === user?.id);
  const isAdmin = myMembership?.role === "admin";

  const loadAll = () => {
    // GET /projects and GET .../members both only require viewer membership,
    // so they're safe to fetch for anyone who can legitimately reach this
    // page — this project simply not appearing in the projects list (rather
    // than a 403) is what makes another project's settings invisible to a
    // non-member. Invites and API keys are admin-only on the backend, so
    // they're fetched separately, AFTER we know the caller's real role —
    // fetching them eagerly for a viewer would 403 and (via Promise.all)
    // wrongly blank the entire page instead of just hiding those sections.
    Promise.all([getProjects(), getMembers(id)])
      .then(([projects, memberList]) => {
        const project = projects.find((p) => p.id === id);
        if (!project) {
          setNotFound(true);
          return;
        }
        setProjectName(project.name);
        setNameDraft(project.name);
        setMembers(memberList);

        const mine = memberList.find((m) => m.user_id === user?.id);
        if (mine?.role === "admin") {
          Promise.all([getInvites(id), getApiKeys(id)])
            .then(([inviteList, keyList]) => {
              setInvites(inviteList);
              setApiKeys(keyList);
            })
            .catch((err) => setError(err.message));
        }
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  };

  useEffect(loadAll, [id]);

  const handleRename = (e) => {
    e.preventDefault();
    if (!nameDraft.trim() || nameDraft === projectName) return;
    renameProject(id, nameDraft.trim())
      .then((updated) => setProjectName(updated.name))
      .catch((err) => setError(err.message));
  };

  const handleInvite = (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    createInvite(id, { email: inviteEmail.trim(), role: inviteRole })
      .then((invite) => {
        setNewInviteLink(`${window.location.origin}/invites/accept?token=${invite.token}`);
        setInviteEmail("");
        loadAll();
      })
      .catch((err) => setError(err.message));
  };

  const handleRoleChange = (userId, role) => {
    updateMemberRole(id, userId, role).then(loadAll).catch((err) => setError(err.message));
  };

  const handleRemoveMember = (userId, email) => {
    if (!window.confirm(`Remove ${email} from this project?`)) return;
    removeMember(id, userId).then(loadAll).catch((err) => setError(err.message));
  };

  const handleRevokeInvite = (inviteId) => {
    revokeInvite(id, inviteId).then(loadAll).catch((err) => setError(err.message));
  };

  const handleGenerateKey = () => {
    createApiKey(id)
      .then((key) => {
        setNewApiKey(key.api_key);
        loadAll();
      })
      .catch((err) => setError(err.message));
  };

  const handleRevokeKey = (keyId) => {
    if (!window.confirm("Revoke this API key? Anything still using it will immediately lose access.")) return;
    revokeApiKey(id, keyId).then(loadAll).catch((err) => setError(err.message));
  };

  if (loading) {
    return <div className="text-[var(--text-muted)]">Loading...</div>;
  }

  if (notFound) {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Project not found</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Either this project doesn't exist, or you're not a member of it.{" "}
          <Link to="/" className="text-[var(--brand-primary)] hover:underline">
            Go back
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Settings</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">{projectName} — visible only to its members.</p>

      {error && <div className="text-sm text-[var(--brand-danger)] mb-4">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Project Settings */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Project Settings</div>
          <form onSubmit={handleRename}>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Project Name</label>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              disabled={!isAdmin}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2 py-1.5 text-sm text-[var(--text-primary)] mb-3 focus:outline-none focus:border-[var(--brand-primary)] disabled:opacity-60"
            />
            {isAdmin && (
              <button
                type="submit"
                className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-1.5 hover:opacity-90 transition-opacity"
              >
                Save Changes
              </button>
            )}
          </form>
        </div>

        {/* Team Management */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Team Management</div>
          <div className="text-xs text-[var(--text-muted)] mb-2">Members</div>
          <div className="flex flex-col gap-1 mb-3 max-h-40 overflow-y-auto">
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between text-sm text-[var(--text-secondary)] py-1">
                <span className="truncate">
                  {m.name || m.email} <span className="text-[var(--text-muted)]">· {m.role}</span>
                </span>
                {isAdmin && m.user_id !== user.id && (
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <button
                      onClick={() => handleRoleChange(m.user_id, m.role === "admin" ? "viewer" : "admin")}
                      className="text-[10px] text-[var(--brand-primary)] hover:underline"
                    >
                      {m.role === "admin" ? "make viewer" : "make admin"}
                    </button>
                    <button
                      onClick={() => handleRemoveMember(m.user_id, m.email)}
                      className="text-[10px] text-[var(--brand-danger)] hover:underline"
                    >
                      remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {invites.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">Pending Invites</div>
              {invites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between text-xs text-[var(--text-muted)] py-0.5">
                  <span className="truncate">{inv.email} · {inv.role}</span>
                  {isAdmin && (
                    <button onClick={() => handleRevokeInvite(inv.id)} className="text-[var(--brand-danger)] hover:underline shrink-0 ml-2">
                      revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {isAdmin && (
            <form onSubmit={handleInvite} className="flex flex-col gap-2">
              <input
                type="email"
                placeholder="teammate@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none"
              >
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="submit"
                className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-1.5 hover:opacity-90 transition-opacity"
              >
                Add Member
              </button>
            </form>
          )}

          {newInviteLink && (
            <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[var(--text-muted)]">Invite link — copy now, shown once</span>
                <CopyButton text={newInviteLink} />
              </div>
              <div className="text-[10px] text-[var(--text-secondary)] font-mono break-all bg-[var(--bg-input)] border border-[var(--border-subtle)] p-2">
                {newInviteLink}
              </div>
            </div>
          )}
        </div>

        {/* API Keys */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-3">API Keys</div>
          <div className="text-xs text-[var(--text-muted)] mb-2">Active Keys</div>
          <div className="flex flex-col gap-1 mb-3">
            {!isAdmin ? (
              <div className="text-xs text-[var(--text-muted)]">Only admins can view API keys.</div>
            ) : (
              <>
                {apiKeys.filter((k) => !k.revoked_at).map((k) => (
                  <div key={k.id} className="flex items-center justify-between text-sm text-[var(--text-secondary)] py-1">
                    <span className="font-mono">{k.key_prefix}...</span>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-[10px] text-[var(--text-muted)]">{formatDate(k.created_at)}</span>
                      <button onClick={() => handleRevokeKey(k.id)} className="text-[10px] text-[var(--brand-danger)] hover:underline">
                        revoke
                      </button>
                    </div>
                  </div>
                ))}
                {apiKeys.filter((k) => !k.revoked_at).length === 0 && (
                  <div className="text-xs text-[var(--text-muted)]">No active keys.</div>
                )}
              </>
            )}
          </div>
          {isAdmin && (
            <button
              onClick={handleGenerateKey}
              className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-1.5 hover:opacity-90 transition-opacity"
            >
              Generate New Key
            </button>
          )}
          {newApiKey && (
            <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[var(--text-muted)]">New key — copy now, shown once</span>
                <CopyButton text={newApiKey} />
              </div>
              <div className="text-[10px] text-[var(--text-secondary)] font-mono break-all bg-[var(--bg-input)] border border-[var(--border-subtle)] p-2">
                {newApiKey}
              </div>
            </div>
          )}
        </div>

        {/* Billing */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Billing</div>
          <div className="text-xs text-[var(--text-muted)] mb-1">Current Plan</div>
          <div className="text-sm text-[var(--text-secondary)] mb-4">Free (no billing account connected)</div>
          <button
            disabled
            title="Real billing needs a Stripe account connected to this app first"
            className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-1.5 opacity-40 cursor-not-allowed"
          >
            Coming Soon
          </button>
        </div>
      </div>
    </div>
  );
}
