import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTraces, flagTrace, createScore } from "../api";
import Skeleton from "../components/Skeleton";
import StatusPill from "../components/StatusPill";
import { extractProvider, formatRelativeTime } from "../utils";

function ReviewSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

// A queue of traces a human explicitly flagged (via TraceDetails' "Flag for
// review" button), plus a quick manual scoring form. There's no automatic
// triage here — flagging is a deliberate human action, this page just
// collects what's been flagged so far.
export default function Review() {
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scoreDrafts, setScoreDrafts] = useState({});

  const refresh = () =>
    getTraces().then((data) => setTraces(data.filter((t) => t.flagged_for_review)));

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleResolve = async (id) => {
    await flagTrace(id, { flagged_for_review: false, review_note: null });
    await refresh();
  };

  const handleScoreSubmit = async (id) => {
    const draft = scoreDrafts[id];
    if (!draft?.name?.trim() || draft.value === undefined || draft.value === "") return;
    await createScore({
      trace_id: id,
      score_name: draft.name.trim(),
      score_value: Number(draft.value),
      explanation: draft.explanation?.trim() || null,
    });
    setScoreDrafts((prev) => ({ ...prev, [id]: { name: "", value: "", explanation: "" } }));
  };

  if (loading) return <ReviewSkeleton />;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Review Queue</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Traces flagged for a second look — resolve once handled, or record a manual score.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      {traces.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 text-sm text-[var(--text-muted)]">
          Nothing flagged right now. Flag a trace from its detail page to add it here.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {traces.map((t) => {
            const draft = scoreDrafts[t.id] || { name: "", value: "", explanation: "" };
            return (
              <div key={t.id} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <Link to={`/traces/${t.id}`} className="text-sm font-medium text-[var(--brand-primary)] hover:underline">
                      {t.name}
                    </Link>
                    <div className="text-xs text-[var(--text-muted)] mt-0.5">
                      {extractProvider(t.name)} · {formatRelativeTime(t.started_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill status={t.status} />
                    <button
                      onClick={() => handleResolve(t.id)}
                      className="text-xs px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 transition-colors"
                    >
                      Resolve
                    </button>
                  </div>
                </div>
                {t.review_note && (
                  <div className="text-sm text-[var(--text-secondary)] mb-3 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-2">
                    {t.review_note}
                  </div>
                )}
                <div className="flex gap-2 items-center">
                  <input
                    value={draft.name}
                    onChange={(e) => setScoreDrafts((prev) => ({ ...prev, [t.id]: { ...draft, name: e.target.value } }))}
                    placeholder="Score name (e.g. accuracy)"
                    className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                  />
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.1"
                    value={draft.value}
                    onChange={(e) => setScoreDrafts((prev) => ({ ...prev, [t.id]: { ...draft, value: e.target.value } }))}
                    placeholder="0-1"
                    className="w-20 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                  />
                  <input
                    value={draft.explanation}
                    onChange={(e) => setScoreDrafts((prev) => ({ ...prev, [t.id]: { ...draft, explanation: e.target.value } }))}
                    placeholder="Explanation (optional)"
                    className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                  />
                  <button
                    onClick={() => handleScoreSubmit(t.id)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white font-medium hover:bg-[var(--brand-primary-hover)] transition-colors"
                  >
                    Save Score
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
