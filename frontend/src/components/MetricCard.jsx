// icon/delta/caption/progress/accent are all optional so existing call sites
// that only pass label+value keep working unchanged. `accent` picks the
// icon badge's color family (defaults to "primary" when an icon is given);
// `delta` is a colored trend ("+12%"/"-8%"); `caption` is a neutral, muted
// annotation line for context that isn't a trend (e.g. "free-tier providers").
export default function MetricCard({ label, value, icon, delta, caption, progress, accent }) {
  const deltaColor = delta && delta.startsWith("-") ? "var(--brand-danger)" : "var(--brand-success)";
  const badgeColor = `var(--brand-${accent || "primary"})`;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-2xl p-4 flex-1 min-w-[160px]">
      <div className="flex items-start justify-between mb-2">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
        {icon && (
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
            style={{
              backgroundColor: `color-mix(in srgb, ${badgeColor} 14%, transparent)`,
              color: badgeColor,
            }}
          >
            {icon}
          </div>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <div className="text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
        {delta && (
          <div className="text-xs font-medium" style={{ color: deltaColor }}>
            {delta}
          </div>
        )}
      </div>
      {caption && <div className="text-xs text-[var(--text-muted)] mt-1">{caption}</div>}
      {progress != null && (
        <div className="h-1.5 rounded-full bg-[var(--hover-overlay)] overflow-hidden mt-3">
          <div
            className="h-full rounded-full bg-[var(--brand-success)]"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
    </div>
  );
}
