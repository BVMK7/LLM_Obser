import { useEffect, useState } from "react";
import { getIncidents, updateIncident } from "../api";
import Skeleton from "../components/Skeleton";
import { formatTimestamp, formatRelativeTime } from "../utils";

const CATEGORY_STYLES = {
  cost: { color: "var(--brand-warning)", bg: "color-mix(in srgb, var(--brand-warning) 12%, transparent)" },
  reliability: { color: "var(--brand-primary)", bg: "color-mix(in srgb, var(--brand-primary) 12%, transparent)" },
  performance: { color: "var(--text-secondary)", bg: "color-mix(in srgb, var(--text-secondary) 12%, transparent)" },
  safety: { color: "var(--brand-danger)", bg: "color-mix(in srgb, var(--brand-danger) 12%, transparent)" },
};

const SEVERITY_STYLES = {
  low: { color: "var(--text-muted)", bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)" },
  medium: { color: "var(--brand-warning)", bg: "color-mix(in srgb, var(--brand-warning) 12%, transparent)" },
  high: { color: "var(--brand-danger)", bg: "color-mix(in srgb, var(--brand-danger) 12%, transparent)" },
};

const STATUS_STYLES = {
  open: { color: "var(--brand-danger)", bg: "color-mix(in srgb, var(--brand-danger) 12%, transparent)" },
  acknowledged: { color: "var(--brand-warning)", bg: "color-mix(in srgb, var(--brand-warning) 12%, transparent)" },
  resolved: { color: "var(--brand-success)", bg: "color-mix(in srgb, var(--brand-success) 12%, transparent)" },
};

const SOURCE_LABELS = { alert_rule: "Alert Rule", trace_flag: "Trace Flag", kill_switch: "Kill-Switch" };

function Pill({ styles, value, fallbackKey = "medium" }) {
  const style = styles[value] || styles[fallbackKey];
  return (
    <span
      className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {value}
    </span>
  );
}

function IncidentsSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}

// One incident per (project, category) that's currently open — correlates
// AlertRule triggers, trace_flags, and kill-switch halts that used to live
// in three disconnected places (Alerts/Review Queue/session status). Each
// carries an LLM-generated advisory recovery suggestion (never auto-acted
// on) and an explicit lifecycle a human works through: open -> acknowledged
// -> resolved. Resolved is terminal — a new signal after that opens a new
// incident instead of reviving this one.
export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [transitioningId, setTransitioningId] = useState(null);

  const refresh = () =>
    getIncidents({ status: statusFilter || undefined, category: categoryFilter || undefined }).then(setIncidents);

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, categoryFilter]);

  const handleTransition = async (id, status) => {
    setTransitioningId(id);
    try {
      await updateIncident(id, { status });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setTransitioningId(null);
    }
  };

  if (loading) return <IncidentsSkeleton />;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Incidents</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Alert rule triggers, review-queue flags, and kill-switch halts correlated into one thing to watch per problem
        — with an advisory, LLM-suggested next step. Nothing here is auto-acted on except the lifecycle bookkeeping
        itself, if automation is enabled in Project Settings.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="flex gap-2 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
        >
          <option value="">All categories</option>
          <option value="cost">Cost</option>
          <option value="reliability">Reliability</option>
          <option value="performance">Performance</option>
          <option value="safety">Safety</option>
        </select>
      </div>

      {incidents.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 text-sm text-[var(--text-muted)]">
          Nothing here. Incidents open automatically from a triggered alert rule, a review-queue flag, or a
          kill-switch halt — there's no manual "create incident" action.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {incidents.map((inc) => (
            <div key={inc.id} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Pill styles={CATEGORY_STYLES} value={inc.category} />
                  <Pill styles={SEVERITY_STYLES} value={inc.severity} />
                  <Pill styles={STATUS_STYLES} value={inc.status} fallbackKey="open" />
                  <span className="text-xs text-[var(--text-muted)]">
                    opened {formatRelativeTime(inc.opened_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {inc.status !== "acknowledged" && inc.status !== "resolved" && (
                    <button
                      onClick={() => handleTransition(inc.id, "acknowledged")}
                      disabled={transitioningId === inc.id}
                      className="text-xs px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 disabled:opacity-40 transition-colors"
                    >
                      Acknowledge
                    </button>
                  )}
                  {inc.status !== "resolved" && (
                    <button
                      onClick={() => handleTransition(inc.id, "resolved")}
                      disabled={transitioningId === inc.id}
                      className="text-xs px-2.5 py-1 rounded-lg bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 transition-colors"
                    >
                      {transitioningId === inc.id ? "Resolving…" : "Resolve"}
                    </button>
                  )}
                </div>
              </div>

              {inc.recovery_suggestion_json ? (
                <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3 mb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-[var(--text-primary)]">Suggested next step</span>
                    <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                      {inc.recovery_suggestion_json.confidence} confidence
                    </span>
                  </div>
                  <div className="text-sm text-[var(--text-secondary)] mb-2">
                    {inc.recovery_suggestion_json.likely_cause}
                  </div>
                  {inc.recovery_suggestion_json.suggested_actions?.length > 0 && (
                    <ul className="list-disc list-inside text-sm text-[var(--text-secondary)] space-y-0.5">
                      {inc.recovery_suggestion_json.suggested_actions.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="text-xs text-[var(--text-muted)] mb-3">Generating a suggested next step…</div>
              )}

              <div className="flex flex-col gap-2">
                {inc.signals.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-start justify-between gap-3 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium bg-white/5 text-[var(--text-secondary)]">
                          {SOURCE_LABELS[s.source_type] || s.source_type}
                        </span>
                        <span className="text-[11px] text-[var(--text-muted)]">{formatTimestamp(s.created_at)}</span>
                      </div>
                      <div className="text-sm text-[var(--text-secondary)]">{s.reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
