import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getTraces } from "../api";
import MetricCard from "../components/MetricCard";
import ProviderHeatmap from "../components/ProviderHeatmap";
import Skeleton from "../components/Skeleton";
import { formatCost, formatTokens, bucketByTime, TIME_RANGES } from "../utils";

const METRICS = {
  tokens: { label: "Tokens", format: formatTokens, extract: (t) => t.total_tokens || 0 },
  cost: { label: "Cost", format: formatCost, extract: (t) => Number(t.cost) || 0 },
};

function CostUsageSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4 mb-6 flex-wrap">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[160px]">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
      <div className="flex gap-4 items-start flex-wrap">
        <div className="flex-[2] min-w-[320px] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <Skeleton className="h-52 w-full" />
        </div>
        <div className="flex-1 min-w-[240px] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <Skeleton className="h-52 w-full" />
        </div>
      </div>
    </div>
  );
}

// Every configured provider actually runs on a free tier/quota key, so real
// billed spend is always $0 — but `cost` is no longer a hardcoded zero. It's
// a list-price estimate (see providers.py's PRICING/estimate_cost, confirmed
// against each provider's published pricing) applied to the real token counts
// of each call, so it reads as "what this would cost at standard rates," not
// a fabricated number.
export default function CostUsage() {
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState("24H");
  const [metric, setMetric] = useState("tokens");

  useEffect(() => {
    getTraces()
      .then(setTraces)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const { extract } = METRICS[metric];
  const chartData = useMemo(
    () =>
      bucketByTime(traces, range).map(({ time, traces: bucketTraces }) => ({
        time,
        value: bucketTraces.reduce((s, t) => s + extract(t), 0),
      })),
    [traces, range, extract]
  );

  if (loading) {
    return <CostUsageSkeleton />;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Couldn't reach the API — is it running at http://localhost:8010? ({error})
      </div>
    );
  }

  const totalTokens = traces.reduce((s, t) => s + (t.total_tokens || 0), 0);
  const totalRequests = traces.length;
  const avgTokensPerRequest = totalRequests ? Math.round(totalTokens / totalRequests) : null;
  const totalCost = traces.reduce((s, t) => s + (Number(t.cost) || 0), 0);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Cost & Usage</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Token usage and spend across every trace logged so far.
      </p>

      <div className="flex gap-4 mb-6 flex-wrap">
        <MetricCard label="Total Tokens" value={formatTokens(totalTokens)} icon="🗄" />
        <MetricCard label="Total Requests" value={totalRequests} icon="▷" />
        <MetricCard
          label="Avg Tokens / Request"
          value={avgTokensPerRequest != null ? formatTokens(avgTokensPerRequest) : "—"}
          icon="≈"
        />
        <MetricCard label="Cost" value={formatCost(totalCost)} icon="$" caption="Est. at published list pricing" />
      </div>

      <div className="flex gap-4 items-start flex-wrap">
        <div className="flex-[2] min-w-[320px] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">
                {METRICS[metric].label} Over Time
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {metric === "cost" ? "Estimated list-price cost, bucketed over time" : "Total tokens logged, bucketed over time"}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex gap-1">
                {Object.keys(METRICS).map((key) => (
                  <button
                    key={key}
                    onClick={() => setMetric(key)}
                    className={`text-xs px-2.5 py-1 rounded-md capitalize transition-colors ${
                      metric === key
                        ? "bg-[var(--brand-primary)] text-white"
                        : "bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {METRICS[key].label}
                  </button>
                ))}
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
          </div>
          {chartData.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)] mt-4">No trace data in this range.</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={12} tickLine={false} />
                <YAxis
                  stroke="var(--text-muted)"
                  fontSize={12}
                  tickLine={false}
                  allowDecimals={metric === "cost"}
                  tickFormatter={metric === "cost" ? (v) => `$${v.toFixed(6)}` : undefined}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 8,
                  }}
                  labelStyle={{ color: "var(--text-primary)" }}
                  formatter={(v) => [METRICS[metric].format(v), METRICS[metric].label]}
                />
                <Bar dataKey="value" name={METRICS[metric].label} fill="var(--brand-primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="flex-1 min-w-[240px]">
          <ProviderHeatmap traces={traces} metric={metric} title={`${METRICS[metric].label} by Provider`} />
        </div>
      </div>
    </div>
  );
}
