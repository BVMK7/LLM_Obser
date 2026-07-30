import { extractProvider, PROVIDER_COLORS } from "../utils";

// Real percentage breakdown of traces by provider, computed client-side —
// no dedicated backend endpoint needed since provider is embedded in the
// trace name (see extractProvider in utils.js). `metric` picks what's being
// shared out: "count" (default, request share), "tokens", or "cost" — same
// bar-list idiom reused for Cost & Usage's "tokens by provider" instead of
// introducing a second (donut) visual language for the same kind of stat.
export default function ProviderHeatmap({ traces, metric = "count", title = "Provider Heatmap" }) {
  const sums = {};
  for (const t of traces) {
    const provider = extractProvider(t.name);
    const value = metric === "count" ? 1 : metric === "tokens" ? t.total_tokens || 0 : Number(t.cost) || 0;
    sums[provider] = (sums[provider] || 0) + value;
  }
  const total = Object.values(sums).reduce((s, v) => s + v, 0);
  const rows = Object.entries(sums).sort((a, b) => b[1] - a[1]);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
      <div className="text-sm font-medium text-[var(--text-primary)] mb-4">{title}</div>
      {rows.length === 0 || total === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No trace data yet.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(([provider, count]) => {
            const pct = total ? Math.round((count / total) * 100) : 0;
            const color = PROVIDER_COLORS[provider] || PROVIDER_COLORS.unknown;
            return (
              <div key={provider}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[var(--text-secondary)] capitalize">{provider}</span>
                  <span style={{ color }}>{pct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
