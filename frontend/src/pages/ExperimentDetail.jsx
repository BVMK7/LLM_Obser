import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { diffWords } from "diff";
import { getExperiment, getExperiments, analyzeExperiment } from "../api";
import Skeleton from "../components/Skeleton";
import MetricCard from "../components/MetricCard";
import { formatCost, formatTokens, formatTimestamp, scoreKeys, aggregateByProvider } from "../utils";

const TABS = ["Overview", "Results", "Traces", "Charts", "Config"];

function pct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

// Same shape as aggregateByProvider but collapsed across every provider —
// the single "how did this experiment do overall" figure for the stat tiles.
function aggregateOverall(results) {
  const graded = results.filter((r) => r.passed != null);
  const passRate = graded.length ? graded.filter((r) => r.passed).length / graded.length : null;
  const avgScores = {};
  for (const key of scoreKeys(results)) {
    const vals = results.map((r) => r.scores?.[key]).filter((v) => v != null);
    avgScores[key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  }
  return { passRate, avgScores };
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

function OverviewTab({ experiment, analysis, analyzing, onAnalyze, aggregates, compareAggregates, allScoreKeys }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-[var(--text-primary)]">Ask AI</div>
          <button
            onClick={onAnalyze}
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

      <div>
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
    </div>
  );
}

function ResultsTab({ experiment, compareExperiment, matchedRows }) {
  return (
    <div>
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
              {b ? <DiffedAnswer before={b.answer} after={a.answer} /> : <span className="whitespace-pre-wrap">{a.answer}</span>}
            </div>
            <div className="flex gap-4 text-xs text-[var(--text-muted)] flex-wrap">
              {Object.entries(a.scores || {}).map(([k, v]) => (
                <span key={k} className="capitalize">
                  {k}: {b ? <DeltaText before={b.scores?.[k]} after={v} formatFn={pct} isPercent /> : pct(v)}
                </span>
              ))}
              <span>
                {b ? (
                  <DeltaText before={b.latency_ms} after={a.latency_ms} formatFn={(v) => `${Math.round(v)}ms`} higherIsBetter={false} />
                ) : (
                  `${a.latency_ms}ms`
                )}
              </span>
              <span>{formatTokens(a.total_tokens)} tokens</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Only real cases that actually logged a trace (trace_id is set whenever the
// eval run's LLM call went through the SDK's normal trace-creation path) —
// links straight to that trace's real span/timeline detail, not a mock.
function TracesTab({ results }) {
  const withTraces = results.filter((r) => r.trace_id);
  if (withTraces.length === 0) {
    return (
      <div className="text-sm text-[var(--text-muted)]">
        None of this experiment's results have an associated trace (they may have been logged before trace linking
        existed, or created without a real trace_id).
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {withTraces.map((r, i) => (
        <div key={i} className="flex items-center justify-between border border-[var(--border-subtle)] rounded-lg p-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--text-primary)] truncate">{r.question}</div>
            <div className="text-xs text-[var(--text-muted)] capitalize">{r.provider}</div>
          </div>
          <Link to={`/traces/${r.trace_id}`} className="text-xs text-[var(--brand-primary)] hover:underline shrink-0 ml-3">
            View trace ↗
          </Link>
        </div>
      ))}
    </div>
  );
}

// Real per-provider bar comparison of the same aggregates shown as a table
// in Overview — hand-rolled track+fill bars (same idiom as ProviderHeatmap),
// not a charting library, since it's a small fixed set of proportional bars.
function ChartsTab({ aggregates, allScoreKeys }) {
  const metrics = [{ key: "passRate", label: "Pass Rate" }, ...allScoreKeys.map((k) => ({ key: k, label: k }))];
  return (
    <div className="flex flex-col gap-6">
      {metrics.map(({ key, label }) => (
        <div key={key}>
          <div className="text-xs uppercase text-[var(--text-muted)] mb-2 capitalize">{label}</div>
          <div className="flex flex-col gap-2">
            {aggregates.map((row) => {
              const value = key === "passRate" ? row.passRate : row.avgScores[key];
              return (
                <div key={row.provider} className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text-secondary)] capitalize w-20 shrink-0">{row.provider}</span>
                  <div className="h-2 flex-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--brand-primary)]"
                      style={{ width: `${Math.min(100, Math.max(0, (value || 0) * 100))}%` }}
                    />
                  </div>
                  <span className="text-xs text-[var(--text-muted)] w-10 text-right shrink-0">{pct(value)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConfigTab({ experiment }) {
  return (
    <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-4 flex flex-col gap-2 text-sm max-w-xl">
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Providers</span>
        <span className="text-[var(--text-primary)] capitalize text-right">{experiment.providers.join(", ") || "—"}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Scorers</span>
        <span className="text-[var(--text-primary)] text-right">{experiment.scorer_slugs.join(", ") || "—"}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Dataset</span>
        <span className="text-[var(--text-primary)] text-right">{experiment.dataset_id || "—"}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Created</span>
        <span className="text-[var(--text-primary)]">{formatTimestamp(experiment.created_at)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Results</span>
        <span className="text-[var(--text-primary)]">{experiment.results.length}</span>
      </div>
    </div>
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
  const [tab, setTab] = useState("Overview");

  useEffect(() => {
    setLoading(true);
    setExperiment(null);
    setAnalysis(null);
    setCompareId("");
    setCompareExperiment(null);
    setTab("Overview");
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
  const overall = useMemo(() => (experiment ? aggregateOverall(experiment.results) : null), [experiment]);
  const compareOverall = useMemo(
    () => (compareExperiment ? aggregateOverall(compareExperiment.results) : null),
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

  const allScoreKeys = scoreKeys(experiment.results).slice(0, 3);

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

      <div className="flex gap-4 mb-6 flex-wrap">
        <MetricCard
          label="Overall Score"
          value={pct(overall.passRate)}
          progress={overall.passRate != null ? overall.passRate * 100 : null}
          accent="primary"
          delta={
            compareOverall && compareOverall.passRate != null && overall.passRate != null
              ? `${overall.passRate - compareOverall.passRate >= 0 ? "+" : ""}${Math.round((overall.passRate - compareOverall.passRate) * 100)}pp`
              : undefined
          }
        />
        {allScoreKeys.map((k) => (
          <MetricCard
            key={k}
            label={k}
            value={pct(overall.avgScores[k])}
            progress={overall.avgScores[k] != null ? overall.avgScores[k] * 100 : null}
            delta={
              compareOverall && compareOverall.avgScores[k] != null && overall.avgScores[k] != null
                ? `${overall.avgScores[k] - compareOverall.avgScores[k] >= 0 ? "+" : ""}${Math.round((overall.avgScores[k] - compareOverall.avgScores[k]) * 100)}pp`
                : undefined
            }
          />
        ))}
      </div>

      <div className="flex gap-1 mb-4 border-b border-[var(--border-subtle)]">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-[var(--brand-primary)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        {tab === "Overview" && (
          <OverviewTab
            experiment={experiment}
            analysis={analysis}
            analyzing={analyzing}
            onAnalyze={handleAnalyze}
            aggregates={aggregates}
            compareAggregates={compareAggregates}
            allScoreKeys={scoreKeys(experiment.results)}
          />
        )}
        {tab === "Results" && (
          <ResultsTab experiment={experiment} compareExperiment={compareExperiment} matchedRows={matchedRows} />
        )}
        {tab === "Traces" && <TracesTab results={experiment.results} />}
        {tab === "Charts" && <ChartsTab aggregates={aggregates} allScoreKeys={scoreKeys(experiment.results)} />}
        {tab === "Config" && <ConfigTab experiment={experiment} />}
      </div>
    </div>
  );
}
