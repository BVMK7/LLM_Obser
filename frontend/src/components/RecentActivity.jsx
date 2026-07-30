import { Link } from "react-router-dom";
import { extractProvider, formatRelativeTime } from "../utils";

// Compact feed of the most recent traces (any status, not just errors) —
// stacked below ProviderHeatmap on Overview so that column isn't left with
// dead space under the chart. Reuses the same traces list Overview already
// fetched, so no extra API calls.
export default function RecentActivity({ traces }) {
  const recent = [...traces]
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
    .slice(0, 5);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1">
      <div className="text-sm font-medium text-[var(--text-primary)] mb-4">Recent Activity</div>
      {recent.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No traces yet.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {recent.map((trace) => (
            <Link
              key={trace.id}
              to={`/traces?trace=${trace.id}`}
              className="flex items-center justify-between gap-2 text-xs group"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className="w-1.5 h-1.5 rounded-full inline-block shrink-0"
                  style={{
                    backgroundColor: trace.status === "error" ? "var(--brand-danger)" : "var(--brand-success)",
                  }}
                />
                <span className="text-[var(--text-primary)] truncate group-hover:underline">{trace.name}</span>
                <span className="text-[var(--text-muted)] capitalize shrink-0">
                  · {extractProvider(trace.name)}
                </span>
              </span>
              <span className="text-[var(--text-muted)] shrink-0">{formatRelativeTime(trace.started_at)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
