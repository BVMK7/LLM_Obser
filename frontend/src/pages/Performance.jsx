import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getTraces, API_BASE } from "../api";
import MetricCard from "../components/MetricCard";
import Skeleton from "../components/Skeleton";
import { extractProvider, formatDuration, percentile, bucketByTime, TIME_RANGES } from "../utils";

function PerformanceSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4 mb-6 flex-wrap">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[160px]">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <Skeleton className="h-52 w-full" />
      </div>
    </div>
  );
}

function durationsOf(traces) {
  return traces.filter((t) => t.ended_at).map((t) => new Date(t.ended_at) - new Date(t.started_at));
}

// Per-bucket P50/P95/P99 would run on 0-3 samples per hour in a single-user
// app and mostly show noise. All-time percentiles (over the full sample) are
// statistically meaningful; the over-time chart sticks to a single P95 line,
// matching the headline-latency convention Overview/Traces already use.
export default function Performance() {
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState("24H");

  useEffect(() => {
    getTraces()
      .then(setTraces)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const latencyData = useMemo(
    () =>
      bucketByTime(traces, range).map(({ time, traces: bucketTraces }) => ({
        time,
        p95: percentile(durationsOf(bucketTraces), 0.95),
      })),
    [traces, range]
  );

  if (loading) {
    return <PerformanceSkeleton />;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Couldn't reach the API at {API_BASE} — is it running/reachable, and is your API key valid? ({error})
      </div>
    );
  }

  const allDurations = durationsOf(traces);
  const p50 = percentile(allDurations, 0.5);
  const p95 = percentile(allDurations, 0.95);
  const p99 = percentile(allDurations, 0.99);

  const providerRows = computeProviderLatency(traces);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Performance</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Latency across every completed trace, all-time and over time.
      </p>

      <div className="flex gap-4 mb-6 flex-wrap">
        <MetricCard label="P50 Latency" value={p50 != null ? `${Math.round(p50)}ms` : "—"} icon="⏱" />
        <MetricCard label="P95 Latency" value={p95 != null ? `${Math.round(p95)}ms` : "—"} icon="⏱" />
        <MetricCard label="P99 Latency" value={p99 != null ? `${Math.round(p99)}ms` : "—"} icon="⏱" />
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="text-sm font-medium text-[var(--text-primary)]">P95 Latency Over Time</div>
            <div className="text-xs text-[var(--text-muted)]">Bucketed over time</div>
          </div>
          <div className="flex gap-1">
            {Object.keys(TIME_RANGES).map((key) => (
              <button
                key={key}
                onClick={() => setRange(key)}
                className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                  range === key
                    ? "bg-[var(--brand-primary)] text-white"
                    : "bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        </div>
        {latencyData.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)] mt-4">No trace data in this range.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={latencyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={12} tickLine={false} />
              <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                }}
                labelStyle={{ color: "var(--text-primary)" }}
              />
              <Line type="monotone" dataKey="p95" name="P95" stroke="var(--brand-primary)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-4">Latency by Provider</div>
        {providerRows.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">No trace data yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Provider</th>
                <th className="pb-2 font-normal">Requests</th>
                <th className="pb-2 font-normal">Avg Latency</th>
                <th className="pb-2 font-normal">P95 Latency</th>
              </tr>
            </thead>
            <tbody>
              {providerRows.map((row) => (
                <tr key={row.provider} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2 text-[var(--text-primary)] capitalize">{row.provider}</td>
                  <td className="py-2 text-[var(--text-secondary)]">{row.count}</td>
                  <td className="py-2 text-[var(--text-secondary)]">
                    {row.avgMs != null ? `${Math.round(row.avgMs)}ms` : "—"}
                  </td>
                  <td className="py-2 text-[var(--text-secondary)]">
                    {row.p95Ms != null ? `${Math.round(row.p95Ms)}ms` : "—"}
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

// Groups traces by provider and computes avg/P95 latency per group — a
// plain helper (not a hook, despite living in a page file) called inline in
// the render body, matching how Overview/Traces derive their own stats
// without a dedicated backend endpoint.
function computeProviderLatency(traces) {
  const groups = {};
  for (const t of traces) {
    const provider = extractProvider(t.name);
    (groups[provider] ||= []).push(t);
  }
  return Object.entries(groups)
    .map(([provider, rows]) => {
      const durations = durationsOf(rows);
      const avgMs = durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : null;
      return { provider, count: rows.length, avgMs, p95Ms: percentile(durations, 0.95) };
    })
    .sort((a, b) => b.count - a.count);
}
