import { useEffect, useState } from "react";
import { getPolicies, createPolicy, updatePolicy, deletePolicy } from "../api";
import Skeleton from "../components/Skeleton";

const RULE_TYPES = [
  { value: "blocked_model", label: "Blocked Model" },
  { value: "blocked_tool", label: "Blocked Tool" },
  { value: "max_cost_per_call", label: "Max Cost / Call" },
];

function draftRule() {
  return { name: "", rule_type: "blocked_model", value: "" };
}

// Collapses the type-specific config field down to one plain-text input the
// form shows/reads — a comma-separated list for the two "blocked" types, a
// single number for the cost cap — then expands it back into the JSONB
// shape check_policy() on the backend expects (config.models / config.tools
// / config.max_cost).
function draftToConfig(draft) {
  if (draft.rule_type === "blocked_model") {
    return { models: draft.value.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  if (draft.rule_type === "blocked_tool") {
    return { tools: draft.value.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  return { max_cost: Number(draft.value) };
}

function configToValue(rule) {
  if (rule.rule_type === "blocked_model") return (rule.config.models || []).join(", ");
  if (rule.rule_type === "blocked_tool") return (rule.config.tools || []).join(", ");
  return String(rule.config.max_cost ?? "");
}

function configSummary(rule) {
  if (rule.rule_type === "blocked_model") return `Blocks: ${(rule.config.models || []).join(", ") || "(none set)"}`;
  if (rule.rule_type === "blocked_tool") return `Blocks: ${(rule.config.tools || []).join(", ") || "(none set)"}`;
  return `Cap: $${Number(rule.config.max_cost ?? 0).toFixed(4)} / call`;
}

function isDraftValid(draft) {
  if (!draft.name.trim() || !draft.value.trim()) return false;
  if (draft.rule_type === "max_cost_per_call") return !Number.isNaN(Number(draft.value)) && Number(draft.value) > 0;
  return true;
}

function PoliciesSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// Advisory rules an agent checks against before acting (POST
// /policies/check via client.check_policy(...) in the SDK) — nothing here
// blocks a write itself, same precedent as the kill-switch and guardrails.
// Same list + inline-create-form layout as Alerts.jsx.
export default function Policies() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(draftRule());
  const [creating, setCreating] = useState(false);

  const refresh = () => getPolicies().then(setRules);

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!isDraftValid(draft)) return;
    setCreating(true);
    setError(null);
    try {
      await createPolicy({
        name: draft.name.trim(),
        rule_type: draft.rule_type,
        config: draftToConfig(draft),
        enabled: true,
      });
      setDraft(draftRule());
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleToggleEnabled = async (rule) => {
    try {
      await updatePolicy(rule.id, {
        name: rule.name,
        rule_type: rule.rule_type,
        config: rule.config,
        enabled: !rule.enabled,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  // Value/type edits reuse the same prompt-based quick edit as Alerts.jsx's
  // webhook column — this row is already dense, and edits here are rare.
  const handleEditValue = async (rule) => {
    const currentValue = configToValue(rule);
    const label = rule.rule_type === "max_cost_per_call" ? "Max cost per call ($):" : "Comma-separated values:";
    const next = window.prompt(label, currentValue);
    if (next === null) return;
    try {
      await updatePolicy(rule.id, {
        name: rule.name,
        rule_type: rule.rule_type,
        config: draftToConfig({ rule_type: rule.rule_type, value: next }),
        enabled: rule.enabled,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this policy? Agents checking against it will stop seeing this rule.")) return;
    await deletePolicy(id);
    await refresh();
  };

  if (loading) return <PoliciesSkeleton />;

  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Policies</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Rules an agent checks before acting (blocked models/tools, per-call cost caps) — {enabledCount} of{" "}
        {rules.length} enabled. Advisory only: nothing here blocks a call automatically, the calling agent decides.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        {rules.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">No policies yet — create one below.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Name</th>
                <th className="pb-2 font-normal">Type</th>
                <th className="pb-2 font-normal">Rule</th>
                <th className="pb-2 font-normal">Status</th>
                <th className="pb-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2.5 text-[var(--text-primary)]">{rule.name}</td>
                  <td className="py-2.5 text-[var(--text-secondary)]">
                    {RULE_TYPES.find((t) => t.value === rule.rule_type)?.label}
                  </td>
                  <td className="py-2.5">
                    <button
                      onClick={() => handleEditValue(rule)}
                      className="text-xs text-[var(--text-secondary)] hover:text-[var(--brand-primary)] hover:underline text-left transition-colors"
                    >
                      {configSummary(rule)}
                    </button>
                  </td>
                  <td className="py-2.5">
                    <button
                      onClick={() => handleToggleEnabled(rule)}
                      className="text-xs px-2 py-0.5 rounded font-medium transition-colors"
                      style={{
                        backgroundColor: rule.enabled
                          ? "color-mix(in srgb, var(--brand-success) 12%, transparent)"
                          : "color-mix(in srgb, var(--text-muted) 12%, transparent)",
                        color: rule.enabled ? "var(--brand-success)" : "var(--text-muted)",
                      }}
                    >
                      {rule.enabled ? "ENABLED" : "DISABLED"}
                    </button>
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--brand-danger)] transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">New Policy</div>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Policy name"
            className="flex-1 min-w-[160px] bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <select
            value={draft.rule_type}
            onChange={(e) => setDraft((d) => ({ ...d, rule_type: e.target.value, value: "" }))}
            className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          >
            {RULE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {draft.rule_type === "max_cost_per_call" ? (
            <input
              type="number"
              min="0"
              step="0.0001"
              value={draft.value}
              onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
              placeholder="Max cost per call ($)"
              className="w-48 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
            />
          ) : (
            <input
              value={draft.value}
              onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
              placeholder={draft.rule_type === "blocked_model" ? "gpt-4, gpt-4-turbo" : "shell_exec, browse_web"}
              className="flex-1 min-w-[220px] bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
            />
          )}
          <button
            onClick={handleCreate}
            disabled={creating || !isDraftValid(draft)}
            className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 transition-colors"
          >
            {creating ? "Creating…" : "Create Policy"}
          </button>
        </div>
      </div>
    </div>
  );
}
