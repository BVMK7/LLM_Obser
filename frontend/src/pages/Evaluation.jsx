import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getProviderStatus, runEvaluationOne, getDatasets, getDataset, createDataset, getScorers, createExperiment } from "../api";
import MetricCard from "../components/MetricCard";
import StatusPill from "../components/StatusPill";
import { downloadFile, formatTokens, percentile, toCSV } from "../utils";

const PROVIDERS = ["gemini", "groq", "openrouter"];
const PASS_THRESHOLD = 0.7; // avg faithfulness/relevance at or above this = "passing"

function emptyCase() {
  return { question: "", expected: "" };
}

function pct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

// One row per provider, averaging this run's per-case judge scores —
// real aggregation over the results the backend just returned, no
// invented history or trend line.
function aggregateByProvider(results) {
  const groups = {};
  for (const r of results) {
    (groups[r.provider] ||= []).push(r);
  }
  return Object.entries(groups).map(([provider, rows]) => {
    const faithfulnessScores = rows.map((r) => r.faithfulness).filter((v) => v != null);
    const relevanceScores = rows.map((r) => r.relevance).filter((v) => v != null);
    const avgFaithfulness = faithfulnessScores.length
      ? faithfulnessScores.reduce((s, v) => s + v, 0) / faithfulnessScores.length
      : null;
    const avgRelevance = relevanceScores.length
      ? relevanceScores.reduce((s, v) => s + v, 0) / relevanceScores.length
      : null;
    const p95Latency = percentile(rows.map((r) => r.latency_ms).filter((v) => v > 0), 0.95);
    const passing = avgFaithfulness != null && avgRelevance != null
      ? avgFaithfulness >= PASS_THRESHOLD && avgRelevance >= PASS_THRESHOLD
      : null;
    return { provider, avgFaithfulness, avgRelevance, p95Latency, passing, count: rows.length };
  });
}

export default function Evaluation() {
  const navigate = useNavigate();
  const [selectedProviders, setSelectedProviders] = useState(["gemini"]);
  const [cases, setCases] = useState([emptyCase()]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [providerStatus, setProviderStatus] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [scorers, setScorers] = useState([]);
  const [selectedScorerSlugs, setSelectedScorerSlugs] = useState([]);
  const [savingExperiment, setSavingExperiment] = useState(false);

  useEffect(() => {
    getProviderStatus()
      .then(setProviderStatus)
      .catch(() => {}); // best-effort — a missing status check shouldn't block the page
    getDatasets()
      .then(setDatasets)
      .catch(() => {}); // best-effort — a missing dataset list shouldn't block the page
    getScorers()
      .then(setScorers)
      .catch(() => {}); // best-effort — a missing scorer list shouldn't block the page
  }, []);

  const toggleScorer = (slug) => {
    setSelectedScorerSlugs((prev) => (prev.includes(slug) ? prev.filter((x) => x !== slug) : [...prev, slug]));
  };

  const handleLoadDataset = async (id) => {
    setSelectedDatasetId(id);
    if (!id) return;
    try {
      const dataset = await getDataset(id);
      setCases(
        dataset.cases.length ? dataset.cases.map((c) => ({ question: c.question, expected: c.expected || "" })) : [emptyCase()]
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveAsDataset = async () => {
    if (validCases.length === 0) return;
    const name = window.prompt("Save these cases as a new dataset — name it:");
    if (!name || !name.trim()) return;
    try {
      await createDataset({
        name: name.trim(),
        cases: validCases.map((c) => ({ question: c.question, expected: c.expected.trim() || null })),
      });
      const refreshed = await getDatasets();
      setDatasets(refreshed);
    } catch (err) {
      setError(err.message);
    }
  };

  const unconfiguredSelected = providerStatus
    ? selectedProviders.filter((p) => providerStatus[p] === false)
    : [];

  const toggleProvider = (p) => {
    setSelectedProviders((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  const updateCase = (index, field, value) => {
    setCases((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  };

  const addCase = () => setCases((prev) => [...prev, emptyCase()]);
  const removeCase = (index) => setCases((prev) => prev.filter((_, i) => i !== index));

  const validCases = cases.filter((c) => c.question.trim());
  const canRun = validCases.length > 0 && selectedProviders.length > 0 && !loading;

  // Runs cases one pair at a time (rather than one big batch call) so the
  // UI can show real progress and fill in results as they land, instead of
  // one long wait followed by everything appearing at once.
  const handleRun = async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    setResults([]);
    setProgress(null);

    const pairs = validCases.flatMap((c) => selectedProviders.map((provider) => ({ case: c, provider })));

    try {
      for (let i = 0; i < pairs.length; i++) {
        const { case: c, provider } = pairs[i];
        setProgress({ current: i + 1, total: pairs.length, label: `${provider} · ${c.question.slice(0, 40)}` });
        const result = await runEvaluationOne({
          provider,
          question: c.question,
          expected: c.expected.trim() || null,
          scorer_slugs: selectedScorerSlugs,
        });
        setResults((prev) => [...(prev || []), result]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const handleExportCSV = () => downloadFile("evaluation-results.csv", toCSV(results), "text/csv");
  const handleExportJSON = () => downloadFile("evaluation-results.json", JSON.stringify(results, null, 2), "application/json");

  // Persists this run's results (already sitting in state right after
  // running) as a named Experiment, so it survives after the page is closed
  // and can be diffed against another run later on the Experiments page.
  const handleSaveAsExperiment = async () => {
    if (!results || results.length === 0) return;
    const name = window.prompt("Save this run as an experiment — name it:");
    if (!name || !name.trim()) return;
    setSavingExperiment(true);
    setError(null);
    try {
      const experiment = await createExperiment({
        name: name.trim(),
        dataset_id: selectedDatasetId || null,
        providers: selectedProviders,
        scorer_slugs: selectedScorerSlugs,
        results: results.map((r) => ({
          question: r.question,
          expected: r.expected,
          provider: r.provider,
          answer: r.answer,
          passed: r.passed,
          scores: {
            ...(r.faithfulness != null ? { faithfulness: r.faithfulness } : {}),
            ...(r.relevance != null ? { relevance: r.relevance } : {}),
            ...r.scorer_scores,
          },
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          total_tokens: r.total_tokens,
          cost: r.cost,
          latency_ms: r.latency_ms,
          trace_id: r.trace_id,
        })),
      });
      navigate(`/experiments/${experiment.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingExperiment(false);
    }
  };

  const gradedPassed = results?.filter((r) => r.passed != null) || [];
  const passRate = gradedPassed.length
    ? Math.round((gradedPassed.filter((r) => r.passed).length / gradedPassed.length) * 100)
    : null;
  const faithfulnessScores = results?.map((r) => r.faithfulness).filter((v) => v != null) || [];
  const avgFaithfulness = faithfulnessScores.length
    ? faithfulnessScores.reduce((s, v) => s + v, 0) / faithfulnessScores.length
    : null;
  const hallucinationJudged = results?.filter((r) => r.hallucination != null) || [];
  const hallucinationRate = hallucinationJudged.length
    ? Math.round((hallucinationJudged.filter((r) => r.hallucination).length / hallucinationJudged.length) * 100)
    : null;
  const comparison = results ? aggregateByProvider(results) : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Evaluation Suite</h1>
        <button
          onClick={addCase}
          className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] transition-colors"
        >
          + New Eval Run
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Run test prompts across providers, graded by keyword match and an LLM judge.
      </p>

      {results && results.length > 0 && (
        <div className="flex gap-4 mb-6 flex-wrap">
          <MetricCard label="Pass Rate" value={pct(passRate != null ? passRate / 100 : null)} icon="✓" />
          <MetricCard label="Cases Run" value={results.length} icon="▤" />
          <MetricCard label="Avg Faithfulness" value={pct(avgFaithfulness)} icon="◎" />
          <MetricCard label="Hallucination Rate" value={pct(hallucinationRate != null ? hallucinationRate / 100 : null)} icon="⚠" />
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <label className="block text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Providers</label>
        <div className="flex gap-4 mb-2">
          {PROVIDERS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={selectedProviders.includes(p)}
                onChange={() => toggleProvider(p)}
                className="accent-[var(--brand-primary)]"
              />
              {p}
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Scorers <span className="normal-case text-[var(--text-muted)]">(optional, in addition to the built-in judge)</span>
          </label>
          <Link to="/scorers" className="text-xs text-[var(--brand-primary)] hover:underline">
            Manage scorers →
          </Link>
        </div>
        <div className="flex gap-4 mb-4 flex-wrap">
          {scorers.length === 0 && <span className="text-xs text-[var(--text-muted)]">No custom scorers yet.</span>}
          {scorers.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={selectedScorerSlugs.includes(s.slug)}
                onChange={() => toggleScorer(s.slug)}
                className="accent-[var(--brand-primary)]"
              />
              {s.name}
            </label>
          ))}
        </div>

        {unconfiguredSelected.length > 0 && (
          <div className="text-xs text-[var(--brand-danger)] mb-4">
            ⚠ {unconfiguredSelected.join(", ")} {unconfiguredSelected.length > 1 ? "aren't" : "isn't"} configured —{" "}
            <Link to="/settings" className="underline">
              check Settings
            </Link>
            .
          </div>
        )}

        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs uppercase tracking-wide text-[var(--text-muted)]">Test cases</label>
          <div className="flex items-center gap-2">
            <select
              value={selectedDatasetId}
              onChange={(e) => handleLoadDataset(e.target.value)}
              className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
            >
              <option value="">Load from Dataset…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.case_count})
                </option>
              ))}
            </select>
            <button
              onClick={handleSaveAsDataset}
              disabled={validCases.length === 0}
              className="text-xs px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save as Dataset
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2 mb-3">
          {cases.map((c, i) => (
            <div key={i} className="flex gap-2 items-start">
              <input
                value={c.question}
                onChange={(e) => updateCase(i, "question", e.target.value)}
                placeholder="Question"
                className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
              />
              <input
                value={c.expected}
                onChange={(e) => updateCase(i, "expected", e.target.value)}
                placeholder="Expected keyword (optional)"
                className="w-56 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
              />
              <button
                onClick={() => removeCase(i)}
                disabled={cases.length === 1}
                className="px-2 py-2 text-[var(--text-muted)] hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Remove case"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={addCase}
            className="px-3 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] text-sm hover:bg-white/10 transition-colors"
          >
            + Add case
          </button>
          <button
            onClick={handleRun}
            disabled={!canRun}
            className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Running…" : "Run Evaluation"}
          </button>
          {progress && (
            <span className="text-xs text-[var(--text-muted)]">
              Case {progress.current}/{progress.total} · {progress.label}…
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-red-400 mb-6">
          Couldn't reach the API — is it running at http://localhost:8010? ({error})
        </div>
      )}

      {comparison.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-4">Model Comparison Table</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Provider</th>
                <th className="pb-2 font-normal">Faithfulness</th>
                <th className="pb-2 font-normal">Relevance</th>
                <th className="pb-2 font-normal">Latency (P95)</th>
                <th className="pb-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.provider} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2 text-[var(--brand-primary)] capitalize">{row.provider}</td>
                  <td className="py-2 text-[var(--text-secondary)]">{pct(row.avgFaithfulness)}</td>
                  <td className="py-2 text-[var(--text-secondary)]">{pct(row.avgRelevance)}</td>
                  <td className="py-2 text-[var(--text-secondary)]">
                    {row.p95Latency != null ? `${(row.p95Latency / 1000).toFixed(2)}s` : "—"}
                  </td>
                  <td className="py-2">
                    <StatusPill status={row.passing == null ? "ungraded" : row.passing ? "passing" : "failing"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-medium text-[var(--text-primary)]">Case Results</div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveAsExperiment}
                disabled={savingExperiment}
                className="text-xs px-2.5 py-1 rounded-lg bg-[var(--brand-primary)] text-white font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 transition-colors"
              >
                {savingExperiment ? "Saving…" : "Save as Experiment"}
              </button>
              <button
                onClick={handleExportCSV}
                className="text-xs px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 transition-colors"
              >
                Export CSV
              </button>
              <button
                onClick={handleExportJSON}
                className="text-xs px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 transition-colors"
              >
                Export JSON
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Question</th>
                <th className="pb-2 font-normal">Expected</th>
                <th className="pb-2 font-normal">Provider</th>
                <th className="pb-2 font-normal">Answer</th>
                <th className="pb-2 font-normal">Keyword Match</th>
                <th className="pb-2 font-normal">Judge</th>
                {selectedScorerSlugs.length > 0 && <th className="pb-2 font-normal">Scorers</th>}
                <th className="pb-2 font-normal">Latency</th>
                <th className="pb-2 font-normal">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0 align-top">
                  <td className="py-2 pr-3 text-[var(--text-primary)] max-w-[180px]">{r.question}</td>
                  <td className="py-2 pr-3 text-[var(--text-muted)]">{r.expected || "—"}</td>
                  <td className="py-2 pr-3 text-[var(--brand-primary)] capitalize">{r.provider}</td>
                  <td className="py-2 pr-3 text-[var(--text-secondary)] max-w-[280px] whitespace-pre-wrap">{r.answer}</td>
                  <td className="py-2 pr-3">
                    <StatusPill status={r.passed == null ? "ungraded" : r.passed ? "pass" : "fail"} />
                  </td>
                  <td className="py-2 pr-3 text-[var(--text-secondary)]" title={r.judge_notes || ""}>
                    {r.faithfulness != null ? `F:${pct(r.faithfulness)} R:${pct(r.relevance)}` : "—"}
                    {r.hallucination && <span className="text-[var(--brand-danger)]"> ⚠</span>}
                  </td>
                  {selectedScorerSlugs.length > 0 && (
                    <td className="py-2 pr-3 text-[var(--text-secondary)]">
                      {Object.entries(r.scorer_scores || {})
                        .map(([name, v]) => `${name}:${pct(v)}`)
                        .join(" · ") || "—"}
                    </td>
                  )}
                  <td className="py-2 pr-3 text-[var(--text-secondary)]">{r.latency_ms}ms</td>
                  <td className="py-2 text-[var(--text-secondary)]">{formatTokens(r.total_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
