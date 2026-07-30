import { useEffect, useState } from "react";
import { getAlertRules, createAlertRule, deleteAlertRule, getAlertsStatus } from "../api";
import Skeleton from "../components/Skeleton";

const METRICS = [
  { value: "error_rate", label: "Error Rate (%)", unit: "%" },
  { value: "p95_latency_ms", label: "P95 Latency (ms)", unit: "ms" },
  { value: "avg_cost_per_request", label: "Avg Cost / Request ($)", unit: "$" },
];

function draftRule() {
  return { name: "", metric: "error_rate", comparator: ">", threshold: 10, window_minutes: 60 };
}

function formatValue(metric, value) {
  if (value == null) return "—";
  if (metric === "avg_cost_per_request") return `$${value.toFixed(6)}`;
  if (metric === "p95_latency_ms") return `${Math.round(value)}ms`;
  return `${value.toFixed(1)}%`;
}

function AlertsSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// Threshold rules checked against real trace data within a trailing window
// (see main.py's _evaluate_alert_rule) — there's no email/Slack integration
// in this app, so "triggered" means "shows up here," not a pushed
// notification. Recomputed fresh every time this page loads.
export default function Alerts() {
  const [rules, setRules] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(draftRule());
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    Promise.all([getAlertRules(), getAlertsStatus()]).then(([r, s]) => {
      setRules(r);
      setStatuses(s);
    });

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!draft.name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createAlertRule({ ...draft, threshold: Number(draft.threshold), window_minutes: Number(draft.window_minutes) });
      setDraft(draftRule());
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id) => {
    await deleteAlertRule(id);
    await refresh();
  };

  if (loading) return <AlertsSkeleton />;

  const triggeredCount = statuses.filter((s) => s.triggered).length;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Alerts</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Threshold rules checked live against real trace data — {triggeredCount > 0 ? (
          <span className="text-[var(--brand-danger)] font-medium">{triggeredCount} currently triggered</span>
        ) : (
          "nothing currently triggered"
        )}.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        {statuses.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">No alert rules yet — create one below.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Rule</th>
                <th className="pb-2 font-normal">Condition</th>
                <th className="pb-2 font-normal">Current Value</th>
                <th className="pb-2 font-normal">Window</th>
                <th className="pb-2 font-normal">Status</th>
                <th className="pb-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {statuses.map(({ rule, current_value, triggered, sample_size }) => {
                const metricInfo = METRICS.find((m) => m.value === rule.metric);
                return (
                  <tr key={rule.id} className="border-b border-[var(--border-subtle)] last:border-0">
                    <td className="py-2.5 text-[var(--text-primary)]">{rule.name}</td>
                    <td className="py-2.5 text-[var(--text-secondary)]">
                      {metricInfo?.label} {rule.comparator} {rule.threshold}
                    </td>
                    <td className="py-2.5 text-[var(--text-secondary)]">
                      {formatValue(rule.metric, current_value)}{" "}
                      <span className="text-xs text-[var(--text-muted)]">({sample_size} traces)</span>
                    </td>
                    <td className="py-2.5 text-[var(--text-secondary)]">{rule.window_minutes}m</td>
                    <td className="py-2.5">
                      <span
                        className="text-xs px-2 py-0.5 rounded font-medium"
                        style={{
                          backgroundColor: triggered
                            ? "color-mix(in srgb, var(--brand-danger) 12%, transparent)"
                            : "color-mix(in srgb, var(--brand-success) 12%, transparent)",
                          color: triggered ? "var(--brand-danger)" : "var(--brand-success)",
                        }}
                      >
                        {triggered ? "TRIGGERED" : "OK"}
                      </span>
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">New Alert Rule</div>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Rule name"
            className="flex-1 min-w-[160px] bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <select
            value={draft.metric}
            onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))}
            className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          >
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            value={draft.comparator}
            onChange={(e) => setDraft((d) => ({ ...d, comparator: e.target.value }))}
            className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          >
            <option value=">">&gt;</option>
            <option value="<">&lt;</option>
          </select>
          <input
            type="number"
            value={draft.threshold}
            onChange={(e) => setDraft((d) => ({ ...d, threshold: e.target.value }))}
            className="w-24 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <input
            type="number"
            value={draft.window_minutes}
            onChange={(e) => setDraft((d) => ({ ...d, window_minutes: e.target.value }))}
            title="Window in minutes"
            className="w-24 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <span className="text-xs text-[var(--text-muted)]">min window</span>
          <button
            onClick={handleCreate}
            disabled={creating || !draft.name.trim()}
            className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 transition-colors"
          >
            {creating ? "Creating…" : "Create Rule"}
          </button>
        </div>
      </div>
    </div>
  );
}
