// Shared formatting helpers used across pages.

export function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return "—";
  const ms = new Date(endedAt) - new Date(startedAt);
  if (ms < 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function formatCost(cost) {
  if (cost === null || cost === undefined) return "$0.0000";
  const value = Number(cost);
  // Sign goes before the "$", not between it and the digits — "$-0.0012"
  // reads as a formatting glitch, "-$0.0012" reads as a negative amount.
  return value < 0 ? `-$${Math.abs(value).toFixed(4)}` : `$${value.toFixed(4)}`;
}

export function formatTokens(tokens) {
  if (tokens === null || tokens === undefined) return "0";
  return Number(tokens).toLocaleString();
}

export function formatTimestamp(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function formatRelativeTime(value) {
  if (!value) return "—";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Traces are named "playground: groq", "eval: groq", or (from the older
// example scripts) "... (groq)" — this pulls the provider out of any of
// those shapes so the UI can group/filter/color by provider without a
// dedicated backend column.
export function extractProvider(name) {
  if (!name) return "unknown";
  const prefixMatch = name.match(/^(?:playground|eval):\s*([\w-]+)/i);
  if (prefixMatch) return prefixMatch[1].toLowerCase();
  const suffixMatch = name.match(/\(([\w-]+)\)\s*$/);
  if (suffixMatch) return suffixMatch[1].toLowerCase();
  return "unknown";
}

// Shared provider→color mapping — used by anything that breaks down traces
// by provider (ProviderHeatmap, Performance, Providers pages) so they don't
// each redefine (and risk diverging from) the same gemini/groq/openrouter
// color assignment.
export const PROVIDER_COLORS = {
  gemini: "var(--brand-warning)",
  groq: "var(--brand-primary)",
  openrouter: "var(--brand-success)",
  unknown: "var(--text-muted)",
};

// Nearest-rank percentile (e.g. p=0.95 for P95 latency) over a plain array of numbers.
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// Range presets shared by every "over time" chart (24H buckets by hour,
// 7D/30D bucket by day).
export const TIME_RANGES = {
  "24H": { hours: 24, bucket: "hour" },
  "7D": { hours: 24 * 7, bucket: "day" },
  "30D": { hours: 24 * 30, bucket: "day" },
};

// Groups traces into time buckets (hour for 24H, day for 7D/30D), sorted
// chronologically before the bucket key is formatted into a display label —
// shared by RequestChart, Performance, and Cost & Usage so each only has to
// aggregate its own metric (counts/sums/percentiles) on top of the same
// grouping. Buckets with zero traces are omitted rather than zero-filled.
export function bucketByTime(traces, rangeKey) {
  const { hours, bucket } = TIME_RANGES[rangeKey];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const buckets = {};

  for (const trace of traces) {
    const started = new Date(trace.started_at);
    if (started.getTime() < cutoff) continue;

    const bucketDate = new Date(started);
    if (bucket === "hour") bucketDate.setMinutes(0, 0, 0);
    else bucketDate.setHours(0, 0, 0, 0);
    const key = bucketDate.toISOString();

    (buckets[key] ||= []).push(trace);
  }

  return Object.entries(buckets)
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([key, items]) => ({
      time:
        bucket === "hour"
          ? new Date(key).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : new Date(key).toLocaleDateString([], { month: "short", day: "numeric" }),
      traces: items,
    }));
}

// Converts an array of flat objects into a CSV string (headers from the
// first row) — generic enough to reuse for any tabular export.
export function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return lines.join("\n");
}

// Triggers a browser download of arbitrary text content — no library needed.
export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Shared by Experiments.jsx (Model Comparison cards) and ExperimentDetail.jsx
// (Per-Provider Summary table) — every distinct score key actually present
// across a set of experiment results, e.g. "faithfulness", "relevance", plus
// whatever custom Scorer names were selected for that run. Not a fixed set —
// the backend's `scores` column is a free-form name→float map (see
// ExperimentResult in main.py), so this reads whatever keys really exist.
export function scoreKeys(results) {
  const keys = new Set();
  for (const r of results) for (const k of Object.keys(r.scores || {})) keys.add(k);
  return Array.from(keys);
}

export function aggregateByProvider(results) {
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
