import { useEffect, useState } from "react";
import { getProviderStatus, getTraces } from "../api";
import Skeleton from "../components/Skeleton";
import { extractProvider, formatTokens } from "../utils";

const KNOWN_PROVIDERS = ["gemini", "groq", "openrouter"];

function ProvidersSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <Skeleton className="h-4 w-32 mb-4" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

function durationsOf(traces) {
  return traces.filter((t) => t.ended_at).map((t) => new Date(t.ended_at) - new Date(t.started_at));
}

// Combines the real /providers/status check (API key configured, same
// endpoint Settings.jsx already uses) with client-computed per-provider
// stats from the trace list — no dedicated backend endpoint for the stats
// half, matching the pattern already used by Overview/ProviderHeatmap.
export default function Providers() {
  const [status, setStatus] = useState(null);
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([getProviderStatus(), getTraces()])
      .then(([statusData, traceData]) => {
        setStatus(statusData);
        setTraces(traceData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <ProvidersSkeleton />;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Couldn't reach the API — is it running at http://localhost:8010? ({error})
      </div>
    );
  }

  const grouped = {};
  for (const t of traces) {
    const provider = extractProvider(t.name);
    (grouped[provider] ||= []).push(t);
  }

  // Union of the known/configurable providers and anything that actually
  // shows up in trace data (e.g. "unknown", from manually-inserted rows) —
  // so a provider with zero traces still appears (with a real "0 requests"),
  // and trace data never silently fails to reconcile with what's shown.
  const allProviders = Array.from(new Set([...KNOWN_PROVIDERS, ...Object.keys(grouped)]));

  const rows = allProviders.map((provider) => {
    const providerTraces = grouped[provider] || [];
    const durations = durationsOf(providerTraces);
    const successCount = providerTraces.filter((t) => t.status === "success").length;
    return {
      provider,
      configured: status ? status[provider] : undefined,
      count: providerTraces.length,
      successRate: providerTraces.length ? Math.round((successCount / providerTraces.length) * 100) : null,
      avgMs: durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : null,
      totalTokens: providerTraces.reduce((s, t) => s + (t.total_tokens || 0), 0),
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Providers</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Configuration status and real usage for every LLM provider this app talks to.
      </p>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
              <th className="pb-2 font-normal">Provider</th>
              <th className="pb-2 font-normal">Status</th>
              <th className="pb-2 font-normal">Requests</th>
              <th className="pb-2 font-normal">Success Rate</th>
              <th className="pb-2 font-normal">Avg Latency</th>
              <th className="pb-2 font-normal">Total Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.provider} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="py-2.5 text-[var(--text-primary)] capitalize">{row.provider}</td>
                <td className="py-2.5">
                  {row.configured === undefined ? (
                    <span className="text-[var(--text-muted)]">—</span>
                  ) : (
                    <span className="flex items-center gap-2 text-[var(--text-secondary)]">
                      <span
                        className="w-2 h-2 rounded-full inline-block"
                        style={{ backgroundColor: row.configured ? "var(--brand-success)" : "var(--brand-danger)" }}
                      />
                      {row.configured ? "configured" : "not configured"}
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">{row.count}</td>
                <td className="py-2.5 text-[var(--text-secondary)]">
                  {row.successRate != null ? `${row.successRate}%` : "—"}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">
                  {row.avgMs != null ? `${Math.round(row.avgMs)}ms` : "—"}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">{formatTokens(row.totalTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
