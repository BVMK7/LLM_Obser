import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getExperiments, getExperiment, deleteExperiment } from "../api";
import Skeleton from "../components/Skeleton";
import Sparkline from "../components/Sparkline";
import { formatTimestamp, aggregateByProvider } from "../utils";

const HISTORY_SIZE = 6;

function pct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function ExperimentsSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4 mb-6 flex-wrap">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[220px]">
            <Skeleton className="h-4 w-24 mb-4" />
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

// A real trend line for one provider's one metric across successive saved
// experiments — only the points where that provider actually appears, in
// chronological order. No fabricated history.
function buildProviderSeries(experimentsInOrder, provider, metricKey) {
  const series = [];
  for (const exp of experimentsInOrder) {
    const row = aggregateByProvider(exp.results).find((r) => r.provider === provider);
    if (!row) continue;
    const value = metricKey === "passRate" ? row.passRate : row.avgScores[metricKey];
    if (value != null) series.push(value);
  }
  return series;
}

function ModelComparisonCard({ provider, experimentsInOrder }) {
  const latest = aggregateByProvider(experimentsInOrder[experimentsInOrder.length - 1].results).find(
    (r) => r.provider === provider
  );
  // A provider can be listed in an experiment's metadata with zero actual
  // result rows (e.g. every case for it errored before scoring) — nothing
  // real to show yet, so skip the card instead of crashing on undefined.
  if (!latest) return null;
  const extraKeys = Object.keys(latest.avgScores).slice(0, 2);
  const metrics = [{ key: "passRate", label: "Pass Rate" }, ...extraKeys.map((k) => ({ key: k, label: k }))];

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[220px]">
      <div className="text-sm font-medium text-[var(--text-primary)] capitalize mb-3">{provider}</div>
      <div className="flex flex-col gap-2.5">
        {metrics.map(({ key, label }) => {
          const series = buildProviderSeries(experimentsInOrder, provider, key);
          const current = series[series.length - 1];
          const previous = series.length > 1 ? series[series.length - 2] : null;
          const delta = previous != null && current != null ? current - previous : null;
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-muted)] capitalize shrink-0">{label}</span>
              <Sparkline values={series} color="var(--brand-primary)" />
              <span className="text-sm text-[var(--text-primary)] font-medium tabular-nums shrink-0 w-24 text-right">
                {pct(current)}
                {delta != null && Math.abs(delta) > 1e-9 && (
                  <span className={delta > 0 ? "text-[var(--brand-success)]" : "text-[var(--brand-danger)]"}>
                    {" "}
                    {delta > 0 ? "+" : ""}
                    {Math.round(delta * 100)}pp
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Persisted snapshots of Evaluation runs (created via "Save as Experiment" on
// the Evaluation page) — unlike a live eval run, these survive after the
// page closes and can be diffed against each other (see ExperimentDetail's
// "Compare to" picker).
export default function Experiments() {
  const [experiments, setExperiments] = useState([]);
  const [history, setHistory] = useState([]); // full detail for the last HISTORY_SIZE, oldest first
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = () =>
    getExperiments().then((list) => {
      setExperiments(list);
      const byDate = [...list].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const recent = byDate.slice(-HISTORY_SIZE);
      return Promise.all(recent.map((e) => getExperiment(e.id))).then(setHistory);
    });

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (e, id, name) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete experiment "${name}"? This can't be undone.`)) return;
    await deleteExperiment(id);
    await refresh();
  };

  if (loading) return <ExperimentsSkeleton />;

  const providersInLatest = history.length ? experiments.find((e) => e.id === history[history.length - 1].id)?.providers || [] : [];

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Experiments</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Saved evaluation runs — open one to see full results, or compare two to see what regressed.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      {history.length > 0 && (
        <div className="mb-6">
          <div className="text-sm font-medium mb-3" style={{ color: "var(--text-on-canvas)" }}>Model Comparison</div>
          <div className="flex gap-4 flex-wrap">
            {providersInLatest.map((provider) => (
              <ModelComparisonCard key={provider} provider={provider} experimentsInOrder={history} />
            ))}
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Recent Experiments</div>
        {experiments.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">
            No experiments yet — run an evaluation and click "Save as Experiment" to create one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Experiment</th>
                <th className="pb-2 font-normal">Providers</th>
                <th className="pb-2 font-normal">Status</th>
                <th className="pb-2 font-normal">Scores</th>
                <th className="pb-2 font-normal">Date</th>
                <th className="pb-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {[...experiments].reverse().map((e) => (
                <tr key={e.id} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2.5">
                    <Link to={`/experiments/${e.id}`} className="text-[var(--brand-primary)] hover:underline">
                      {e.name}
                    </Link>
                    {e.description && <div className="text-xs text-[var(--text-muted)]">{e.description}</div>}
                  </td>
                  <td className="py-2.5 text-[var(--text-secondary)] capitalize">{e.providers.join(", ") || "—"}</td>
                  <td className="py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded bg-[color-mix(in_srgb,var(--brand-success)_12%,transparent)] text-[var(--brand-success)]">
                      {e.result_count > 0 ? "Completed" : "Empty"}
                    </span>
                  </td>
                  <td className="py-2.5 text-[var(--text-secondary)]">
                    {pct(e.pass_rate)} avg · {e.result_count} case{e.result_count === 1 ? "" : "s"}
                  </td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{formatTimestamp(e.created_at)}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={(ev) => handleDelete(ev, e.id, e.name)}
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
    </div>
  );
}
