import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getExperiments, deleteExperiment } from "../api";
import Skeleton from "../components/Skeleton";
import { formatTimestamp } from "../utils";

function pct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function ExperimentsSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
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

// Persisted snapshots of Evaluation runs (created via "Save as Experiment" on
// the Evaluation page) — unlike a live eval run, these survive after the
// page closes and can be diffed against each other (see ExperimentDetail's
// "Compare to" picker).
export default function Experiments() {
  const [experiments, setExperiments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = () => getExperiments().then(setExperiments);

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

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Experiments</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Saved evaluation runs — open one to see full results, or compare two to see what regressed.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        {experiments.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">
            No experiments yet — run an evaluation and click "Save as Experiment" to create one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Name</th>
                <th className="pb-2 font-normal">Providers</th>
                <th className="pb-2 font-normal">Results</th>
                <th className="pb-2 font-normal">Pass Rate</th>
                <th className="pb-2 font-normal">Created</th>
                <th className="pb-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((e) => (
                <tr key={e.id} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2.5">
                    <Link to={`/experiments/${e.id}`} className="text-[var(--brand-primary)] hover:underline">
                      {e.name}
                    </Link>
                    {e.description && <div className="text-xs text-[var(--text-muted)]">{e.description}</div>}
                  </td>
                  <td className="py-2.5 text-[var(--text-secondary)] capitalize">{e.providers.join(", ") || "—"}</td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{e.result_count}</td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{pct(e.pass_rate)}</td>
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
