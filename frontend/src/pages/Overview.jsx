import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTraces, API_BASE } from "../api";
import MetricCard from "../components/MetricCard";
import RequestChart from "../components/RequestChart";
import ProviderHeatmap from "../components/ProviderHeatmap";
import RecentActivity from "../components/RecentActivity";
import StatusPill from "../components/StatusPill";
import Skeleton from "../components/Skeleton";
import {
  formatCost,
  formatDuration,
  formatTokens,
  formatTimestamp,
  extractProvider,
  percentile,
} from "../utils";

const DAY_MS = 24 * 60 * 60 * 1000;

// "+12%"/"-8%" comparing the last 24h to the 24h before that — real
// data, not an invented trend. Returns "—" when there's nothing to compare.
function pctDelta(current, previous) {
  if (!previous) return null;
  const change = ((current - previous) / previous) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(0)}%`;
}

function durationsOf(traces) {
  return traces.filter((t) => t.ended_at).map((t) => new Date(t.ended_at) - new Date(t.started_at));
}

function OverviewSkeleton() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Overview</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">System traces bucketed across all runs.</p>

      <div className="flex gap-4 mb-6 flex-wrap">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[160px]">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>

      <div className="flex gap-4 mb-6 items-start flex-wrap">
        <div className="flex-[2] min-w-[320px] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <Skeleton className="h-52 w-full" />
        </div>
        <div className="flex-1 min-w-[240px] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <Skeleton className="h-52 w-full" />
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <Skeleton className="h-4 w-32 mb-4" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Overview() {
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getTraces()
      .then(setTraces)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <OverviewSkeleton />;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Couldn't reach the API at {API_BASE} — is it running/reachable, and is your API key valid? ({error})
      </div>
    );
  }

  const totalRequests = traces.length;
  const totalCost = traces.reduce((sum, t) => sum + (Number(t.cost) || 0), 0);
  const totalTokens = traces.reduce((sum, t) => sum + (t.total_tokens || 0), 0);
  const p95Latency = percentile(durationsOf(traces), 0.95);

  const now = Date.now();
  const recent = traces.filter((t) => now - new Date(t.started_at).getTime() < DAY_MS);
  const previous = traces.filter((t) => {
    const age = now - new Date(t.started_at).getTime();
    return age >= DAY_MS && age < 2 * DAY_MS;
  });

  const requestsDelta = pctDelta(recent.length, previous.length);
  const tokensDelta = pctDelta(
    recent.reduce((s, t) => s + (t.total_tokens || 0), 0),
    previous.reduce((s, t) => s + (t.total_tokens || 0), 0)
  );
  const costDelta = pctDelta(
    recent.reduce((s, t) => s + (Number(t.cost) || 0), 0),
    previous.reduce((s, t) => s + (Number(t.cost) || 0), 0)
  );
  const recentP95 = percentile(durationsOf(recent), 0.95);
  const prevP95 = percentile(durationsOf(previous), 0.95);
  const latencyDelta =
    recentP95 != null && prevP95 != null
      ? `${recentP95 - prevP95 >= 0 ? "+" : ""}${Math.round(recentP95 - prevP95)}ms`
      : null;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Overview</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">System traces bucketed across all runs.</p>

      <div className="flex gap-4 mb-6 flex-wrap">
        <MetricCard label="Total Requests" value={totalRequests} icon="▷" delta={requestsDelta} />
        <MetricCard
          label="P95 Latency"
          value={p95Latency != null ? `${Math.round(p95Latency)}ms` : "—"}
          icon="⏱"
          delta={latencyDelta}
        />
        <MetricCard label="Total Tokens" value={formatTokens(totalTokens)} icon="🗄" delta={tokensDelta} />
        <MetricCard label="Estimated Cost" value={formatCost(totalCost)} icon="$" delta={costDelta} />
      </div>

      <div className="flex gap-4 mb-6 flex-wrap">
        <div className="flex-[2] min-w-[320px] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-1">Requests Over Time</div>
          <div className="text-xs text-[var(--text-muted)] mb-4">Success vs error traces, bucketed over time</div>
          <RequestChart traces={traces} />
        </div>
        <div className="flex-1 min-w-[240px] flex flex-col gap-4">
          <ProviderHeatmap traces={traces} />
          <RecentActivity traces={traces} />
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-4">Recent Traces</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
              <th className="pb-2 font-normal">Identity / Name</th>
              <th className="pb-2 font-normal">Provider</th>
              <th className="pb-2 font-normal">Timestamp</th>
              <th className="pb-2 font-normal">Latency</th>
              <th className="pb-2 font-normal">Tokens</th>
              <th className="pb-2 font-normal">Cost</th>
              <th className="pb-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {traces.slice(0, 8).map((trace) => (
              <tr key={trace.id} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="py-2.5">
                  <Link to={`/traces?trace=${trace.id}`} className="text-[var(--brand-primary)] hover:underline">
                    {trace.name}
                  </Link>
                </td>
                <td className="py-2.5 text-[var(--text-secondary)] capitalize">
                  <span className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 rounded-full inline-block ${
                        trace.status === "error" ? "bg-[var(--brand-danger)]" : "bg-white/40"
                      }`}
                    />
                    {extractProvider(trace.name)}
                  </span>
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">{formatTimestamp(trace.started_at)}</td>
                <td className="py-2.5 text-[var(--text-secondary)]">
                  {formatDuration(trace.started_at, trace.ended_at)}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">{formatTokens(trace.total_tokens)}</td>
                <td className="py-2.5 text-[var(--text-secondary)]">{formatCost(trace.cost)}</td>
                <td className="py-2.5">
                  <StatusPill status={trace.status} />
                </td>
              </tr>
            ))}
            {traces.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-[var(--text-muted)]">
                  No traces yet.{" "}
                  <Link to="/playground" className="text-[var(--brand-primary)] hover:underline">
                    Go to Playground
                  </Link>{" "}
                  to create your first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
