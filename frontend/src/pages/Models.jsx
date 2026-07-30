import { useEffect, useState } from "react";
import { getModelCatalog, getTraces } from "../api";
import Skeleton from "../components/Skeleton";
import { formatTokens, formatCost } from "../utils";

function ModelsSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
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

// Combines the real model catalog (providers.py's MODEL_CATALOG, via
// GET /models/catalog — the only models this app can actually call) with
// client-computed usage stats grouped by the real traces.model column. Every
// catalog model gets a row even with zero traces so far; any trace logged
// before this column existed (or posted directly to POST /traces without
// one) falls into an "unknown" row rather than silently vanishing.
export default function Models() {
  const [catalog, setCatalog] = useState(null);
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([getModelCatalog(), getTraces()])
      .then(([catalogData, traceData]) => {
        setCatalog(catalogData);
        setTraces(traceData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <ModelsSkeleton />;
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
    const key = t.model || "unknown";
    (grouped[key] ||= []).push(t);
  }

  const catalogRows = Object.entries(catalog).flatMap(([provider, { models, default: defaultModel }]) =>
    models.map((m) => ({ provider, model: m, isDefault: m === defaultModel }))
  );
  const knownModels = new Set(catalogRows.map((r) => r.model));
  const extraRows = Object.keys(grouped)
    .filter((m) => !knownModels.has(m))
    .map((m) => ({ provider: null, model: m, isDefault: false }));

  const rows = [...catalogRows, ...extraRows].map(({ provider, model, isDefault }) => {
    const modelTraces = grouped[model] || [];
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
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Models</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Every model this app is configured to call, with real usage from logged traces. Every key runs on a free
        tier, so nothing is actually billed — cost shown is a list-price estimate applied to real token counts.
      </p>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
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
            {rows.map((row) => (
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
