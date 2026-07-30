import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { diffWords } from "diff";
import { getExperiment, getExperiments, analyzeExperiment } from "../api";
import Skeleton from "../components/Skeleton";
import { formatCost, formatTokens, formatTimestamp } from "../utils";

function pct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

// Every distinct score key seen across a set of results, e.g. "faithfulness",
// "relevance", plus whatever custom Scorer names were selected for the run.
function scoreKeys(results) {
  const keys = new Set();
  for (const r of results) for (const k of Object.keys(r.scores || {})) keys.add(k);
  return Array.from(keys);
}

function aggregateByProvider(results) {
  const groups = {};
  for (const r of results) (groups[r.provider] ||= []).push(r);
  return Object.entries(groups).map(([provider, rows]) => {
    const graded = rows.filter((r) => r.passed != null);
    const passRate = graded.length ? graded.filter((r) => r.passed).length / graded.length : null;
    const avgScores = {};
    for (const key of scoreKeys(rows)) {
      const vals = rows.map((r) => r.scores?.[key]).filter((v) => v != null);
      avgScores[key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    }
    const avgLatency = rows.reduce((s, r) => s + r.latency_ms, 0) / rows.length;
    const totalCost = rows.reduce((s, r) => s + Number(r.cost || 0), 0);
    return { provider, count: rows.length, passRate, avgScores, avgLatency, totalCost };
  });
}

function DeltaText({ before, after, formatFn = (v) => v, higherIsBetter = true, isPercent = false }) {
  if (before == null || after == null) return <span className="text-[var(--text-muted)]">—</span>;
  const diff = after - before;
  const improved = higherIsBetter ? diff > 0 : diff < 0;
  const unchanged = Math.abs(diff) < 1e-9;
  const color = unchanged ? "var(--text-muted)" : improved ? "var(--brand-success)" : "var(--brand-danger)";
  const sign = diff > 0 ? "+" : "";
  const deltaLabel = isPercent ? `${sign}${Math.round(diff * 100)}pp` : `${sign}${formatFn(diff)}`;
  return (
    <span>
      {formatFn(before)} → {formatFn(after)}{" "}
      <span style={{ color }} className="font-medium">
        ({deltaLabel})
      </span>
    </span>
  );
}

export default function ExperimentDetail() {
  const { id } = useParams();
  const [experiment, setExperiment] = useState(null);
  const [allExperiments, setAllExperiments] = useState([]);
  const [compareId, setCompareId] = useState("");
  const [compareExperiment, setCompareExperiment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    setLoading(true);
    setExperiment(null);
    setAnalysis(null);
    setCompareId("");
    setCompareExperiment(null);
    Promise.all([getExperiment(id), getExperiments()])
      .then(([exp, list]) => {
        setExperiment(exp);
        setAllExperiments(list.filter((e) => e.id !== id));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!compareId) {
      setCompareExperiment(null);
      return;
    }
    getExperiment(compareId).then(setCompareExperiment).catch((err) => setError(err.message));
  }, [compareId]);

  const aggregates = useMemo(() => (experiment ? aggregateByProvider(experiment.results) : []), [experiment]);
  const compareAggregates = useMemo(
    () => (compareExperiment ? aggregateByProvider(compareExperiment.results) : []),
    [compareExperiment]
  );

  // Matches a result in the primary experiment to its counterpart in the
  // comparison experiment by (question, provider) — the same real-world
  // pairing Braintrust's diff view uses (same dataset case, same provider).
  const matchedRows = useMemo(() => {
    if (!experiment || !compareExperiment) return [];
    const compareByKey = {};
    for (const r of compareExperiment.results) compareByKey[`${r.question}||${r.provider}`] = r;
    return experiment.results.map((r) => ({ a: r, b: compareByKey[`${r.question}||${r.provider}`] || null }));
  }, [experiment, compareExperiment]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await analyzeExperiment(id);
      setAnalysis(res.analysis);
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return (
      <div>
        <Skeleton className="h-7 w-64 mb-6" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error && !experiment) {
    return <div className="text-red-400">Couldn't load this experiment. ({error})</div>;
  }

  const allScoreKeys = scoreKeys(experiment.results);

  return (
    <div>
      <Link to="/experiments" className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        ← Experiments
      </Link>
      <div className="flex items-center justify-between mt-2 mb-1">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">{experiment.name}</h1>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--text-muted)]">Compare to</label>
          <select
            value={compareId}
            onChange={(e) => setCompareId(e.target.value)}
            className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          >
            <option value="">None</option>
            {allExperiments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        {experiment.description || "No description."} · Created {formatTimestamp(experiment.created_at)}
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-4">Per-Provider Summary</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
              <th className="pb-2 font-normal">Provider</th>
              <th className="pb-2 font-normal">Results</th>
              <th className="pb-2 font-normal">Pass Rate</th>
              {allScoreKeys.map((k) => (
                <th key={k} className="pb-2 font-normal capitalize">{k}</th>
              ))}
              <th className="pb-2 font-normal">Avg Latency</th>
              <th className="pb-2 font-normal">Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {aggregates.map((row) => {
              const compareRow = compareAggregates.find((c) => c.provider === row.provider);
              return (
                <tr key={row.provider} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2 text-[var(--brand-primary)] capitalize">{row.provider}</td>
                  <td className="py-2 text-[var(--text-secondary)]">{row.count}</td>
                  <td className="py-2 text-[var(--text-secondary)]">
                    {compareRow ? (
                      <DeltaText before={compareRow.passRate} after={row.passRate} formatFn={pct} isPercent />
                    ) : (
                      pct(row.passRate)
                    )}
                  </td>
                  {allScoreKeys.map((k) => (
                    <td key={k} className="py-2 text-[var(--text-secondary)]">
                      {compareRow ? (
                        <DeltaText before={compareRow.avgScores[k]} after={row.avgScores[k]} formatFn={pct} isPercent />
                      ) : (
                        pct(row.avgScores[k])
                      )}
                    </td>
                  ))}
                  <td className="py-2 text-[var(--text-secondary)]">
                    {compareRow ? (
                      <DeltaText
                        before={compareRow.avgLatency}
                        after={row.avgLatency}
                        formatFn={(v) => `${Math.round(v)}ms`}
                        higherIsBetter={false}
                      />
                    ) : (
                      `${Math.round(row.avgLatency)}ms`
                    )}
                  </td>
                  <td className="py-2 text-[var(--text-secondary)]">
                    {compareRow ? (
                      <DeltaText before={compareRow.totalCost} after={row.totalCost} formatFn={formatCost} higherIsBetter={false} />
                    ) : (
                      formatCost(row.totalCost)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-[var(--text-primary)]">Ask AI</div>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="text-xs px-2.5 py-1 rounded-lg bg-[var(--brand-primary)] text-white font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 transition-colors"
          >
            {analyzing ? "Analyzing…" : "Analyze this experiment"}
          </button>
        </div>
        {analysis ? (
          <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{analysis}</p>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            A real LLM call reads this experiment's actual worst- and best-scoring cases and explains likely root
            causes, with one concrete suggested fix.
          </p>
        )}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-4">
          {compareExperiment ? `Results — diffed against "${compareExperiment.name}"` : "Results"}
        </div>
        <div className="flex flex-col gap-4">
          {(compareExperiment ? matchedRows : experiment.results.map((a) => ({ a, b: null }))).map(({ a, b }, i) => (
            <div key={i} className="border border-[var(--border-subtle)] rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-[var(--text-primary)] font-medium">{a.question}</div>
                <span className="text-xs text-[var(--brand-primary)] capitalize">{a.provider}</span>
              </div>
              {a.expected && <div className="text-xs text-[var(--text-muted)] mb-2">Expected: {a.expected}</div>}
              <div className="text-sm text-[var(--text-secondary)] mb-2">
                {b ? (
                  <DiffedAnswer before={b.answer} after={a.answer} />
                ) : (
                  <span className="whitespace-pre-wrap">{a.answer}</span>
                )}
              </div>
              <div className="flex gap-4 text-xs text-[var(--text-muted)] flex-wrap">
                {Object.entries(a.scores || {}).map(([k, v]) => (
                  <span key={k} className="capitalize">
                    {k}: {b ? <DeltaText before={b.scores?.[k]} after={v} formatFn={pct} isPercent /> : pct(v)}
                  </span>
                ))}
                <span>{b ? <DeltaText before={b.latency_ms} after={a.latency_ms} formatFn={(v) => `${Math.round(v)}ms`} higherIsBetter={false} /> : `${a.latency_ms}ms`}</span>
                <span>{formatTokens(a.total_tokens)} tokens</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Word-level diff between two answer strings — real character-level content
// comparison (via the `diff` package), not a summary or guess at what changed.
function DiffedAnswer({ before, after }) {
  const parts = diffWords(before || "", after || "");
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => (
        <span
          key={i}
          style={
            part.added
              ? { backgroundColor: "color-mix(in srgb, var(--brand-success) 20%, transparent)" }
              : part.removed
              ? { backgroundColor: "color-mix(in srgb, var(--brand-danger) 20%, transparent)", textDecoration: "line-through" }
              : undefined
          }
        >
          {part.value}
        </span>
      ))}
    </span>
  );
}
