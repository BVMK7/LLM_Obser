import { useEffect, useState } from "react";
import { getProviderStatus, getModelCatalog, getTraces, API_BASE } from "../api";
import Skeleton from "../components/Skeleton";
import { extractProvider, formatTokens, formatCost } from "../utils";
import { UnknownProviderIcon } from "../components/icons";

const KNOWN_PROVIDERS = ["gemini", "groq", "openrouter"];

function ProvidersSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <Skeleton className="h-4 w-32 mb-4" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <Skeleton className="h-4 w-32 mb-4" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
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

// Providers & Models, combined onto one page — they're two views of the
// same underlying trace data (grouped by provider vs. grouped by model),
// so there's no real reason to make them separate pages/nav items.
export default function Providers() {
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([getProviderStatus(), getModelCatalog(), getTraces()])
      .then(([statusData, catalogData, traceData]) => {
        setStatus(statusData);
        setCatalog(catalogData);
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
        Couldn't reach the API at {API_BASE} — is it running/reachable, and is your API key valid? ({error})
      </div>
    );
  }

  const byProvider = {};
  for (const t of traces) {
    const provider = extractProvider(t.name);
    (byProvider[provider] ||= []).push(t);
  }
  // Union of the known/configurable providers and anything that actually
  // shows up in trace data (e.g. "unknown", from manually-inserted rows) —
  // so a provider with zero traces still appears (with a real "0 requests"),
  // and trace data never silently fails to reconcile with what's shown.
  const allProviders = Array.from(new Set([...KNOWN_PROVIDERS, ...Object.keys(byProvider)]));
  const providerRows = allProviders.map((provider) => {
    const providerTraces = byProvider[provider] || [];
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

  const byModel = {};
  for (const t of traces) {
    const key = t.model || "unknown";
    (byModel[key] ||= []).push(t);
  }
  const catalogRows = Object.entries(catalog).flatMap(([provider, { models, default: defaultModel }]) =>
    models.map((m) => ({ provider, model: m, isDefault: m === defaultModel }))
  );
  const knownModels = new Set(catalogRows.map((r) => r.model));
  const extraRows = Object.keys(byModel)
    .filter((m) => !knownModels.has(m))
    .map((m) => ({ provider: null, model: m, isDefault: false }));
  const modelRows = [...catalogRows, ...extraRows].map(({ provider, model, isDefault }) => {
    const modelTraces = byModel[model] || [];
    const durations = durationsOf(modelTraces);
    const successCount = modelTraces.filter((t) => t.status === "success").length;
    return {
      provider,
      model,
      isDefault,
      count: modelTraces.length,
      successRate: modelTraces.length ? Math.round((successCount / modelTraces.length) * 100) : null,
      avgMs: durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : null,
      totalTokens: modelTraces.reduce((s, t) => s + (t.total_tokens || 0), 0),
      totalCost: modelTraces.reduce((s, t) => s + (Number(t.cost) || 0), 0),
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Providers & Models</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Configuration status and real usage for every LLM provider and model this app talks to.
      </p>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Providers</div>
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
            {providerRows.map((row) => (
              <tr key={row.provider} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="py-2.5 text-[var(--text-primary)] capitalize">
                  <span className="flex items-center gap-2">
                    {row.provider === "unknown" && (
                      <span className="w-[18px] shrink-0 text-[var(--text-muted)]">
                        <UnknownProviderIcon />
                      </span>
                    )}
                    {row.provider}
                  </span>
                </td>
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

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Models</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
              <th className="pb-2 font-normal">Model</th>
              <th className="pb-2 font-normal">Provider</th>
              <th className="pb-2 font-normal">Requests</th>
              <th className="pb-2 font-normal">Success Rate</th>
              <th className="pb-2 font-normal">Avg Latency</th>
              <th className="pb-2 font-normal">Total Tokens</th>
              <th className="pb-2 font-normal">Est. Cost</th>
            </tr>
          </thead>
          <tbody>
            {modelRows.map((row) => (
              <tr key={row.model} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="py-2.5 text-[var(--text-primary)]">
                  {row.model}
                  {row.isDefault && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/5 text-[var(--text-muted)]">
                      default
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)] capitalize">{row.provider || "—"}</td>
                <td className="py-2.5 text-[var(--text-secondary)]">{row.count}</td>
                <td className="py-2.5 text-[var(--text-secondary)]">
                  {row.successRate != null ? `${row.successRate}%` : "—"}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">
                  {row.avgMs != null ? `${Math.round(row.avgMs)}ms` : "—"}
                </td>
                <td className="py-2.5 text-[var(--text-secondary)]">{formatTokens(row.totalTokens)}</td>
                <td className="py-2.5 text-[var(--text-secondary)]">{formatCost(row.totalCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
