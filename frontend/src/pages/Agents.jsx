import { useEffect, useState } from "react";
import { getAgents, getAgentCosts } from "../api";
import { formatCost, formatTokens } from "../utils";
import MetricCard from "../components/MetricCard";
import Skeleton from "../components/Skeleton";
import useSessionStream from "../hooks/useSessionStream";

function formatLatency(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function AgentsSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-32 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4 mb-6 flex-wrap">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[160px]">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// Agents auto-register themselves (agent_name on a trace, or the SDK's
// remember()/send_message() calls) — there's no "create an agent" action
// here, so unlike Scorers/Datasets this page is read-only: a per-agent cost
// dashboard (main.py's GET /agents/costs) plus a live session-status
// watcher (GET /sessions/{id}/stream, see useSessionStream).
export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [sessionIdInput, setSessionIdInput] = useState("");
  const [watchedSessionId, setWatchedSessionId] = useState(null);
  const { status, watching, error: streamError, start, stop } = useSessionStream();

  useEffect(() => {
    Promise.all([getAgents(), getAgentCosts()])
      .then(([a, c]) => {
        setAgents(a);
        setCosts(c);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleWatch = (e) => {
    e.preventDefault();
    const id = sessionIdInput.trim();
    if (!id) return;
    setWatchedSessionId(id);
    start(id);
  };

  if (loading) return <AgentsSkeleton />;

  const totalCost = costs.reduce((sum, c) => sum + c.total_cost, 0);
  const totalTraces = costs.reduce((sum, c) => sum + c.trace_count, 0);
  const maxCost = Math.max(1e-9, ...costs.map((c) => c.total_cost));

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Agents</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Cost and activity per registered agent, plus live status for any running session.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="flex gap-4 mb-6 flex-wrap">
        <MetricCard label="Total Agents" value={agents.length} />
        <MetricCard label="Total Cost" value={formatCost(totalCost)} />
        <MetricCard label="Total Traces" value={totalTraces} />
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Per-Agent Cost</div>
        {costs.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">
            No agent-attributed traces yet — pass agent_name to client.traced(...) to see agents here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="pb-2 font-normal">Agent</th>
                <th className="pb-2 font-normal">Traces</th>
                <th className="pb-2 font-normal">Cost</th>
                <th className="pb-2 font-normal">Tokens</th>
                <th className="pb-2 font-normal">Avg Latency</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => (
                <tr key={c.agent_id || "unattributed"} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-2.5 text-[var(--text-primary)]">
                    {c.agent_name}
                    <div className="h-1 rounded-full bg-white/5 overflow-hidden mt-1 w-32">
                      <div
                        className="h-full rounded-full bg-[var(--brand-primary)]"
                        style={{ width: `${Math.max(2, (c.total_cost / maxCost) * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{c.trace_count}</td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{formatCost(c.total_cost)}</td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{formatTokens(c.total_tokens)}</td>
                  <td className="py-2.5 text-[var(--text-secondary)]">{formatLatency(c.avg_latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-1">Live Session Status</div>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Watch an agent session in real time — updates as it runs, until it stops or its project's kill-switch trips it.
        </p>
        <form onSubmit={handleWatch} className="flex gap-2 mb-4">
          <input
            value={sessionIdInput}
            onChange={(e) => setSessionIdInput(e.target.value)}
            placeholder="Session ID"
            className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <button
            type="submit"
            disabled={watching || !sessionIdInput.trim()}
            className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 transition-colors"
          >
            {watching ? "Watching…" : "Watch"}
          </button>
          {watching && (
            <button
              type="button"
              onClick={stop}
              className="px-4 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] text-sm font-medium hover:bg-white/10 transition-colors"
            >
              Stop
            </button>
          )}
        </form>

        {streamError && <div className="text-red-400 text-sm mb-3">{streamError}</div>}

        {status && (
          <div className="flex items-center gap-6 flex-wrap text-sm">
            <div>
              <div className="text-xs text-[var(--text-muted)]">Session</div>
              <div className="font-mono text-[var(--text-secondary)]">{watchedSessionId}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)]">Steps</div>
              <div className="text-[var(--text-primary)]">{status.step_count}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)]">Cost</div>
              <div className="text-[var(--text-primary)]">{formatCost(status.total_cost)}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)]">Elapsed</div>
              <div className="text-[var(--text-primary)]">{formatLatency(status.elapsed_seconds * 1000)}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)] mb-0.5">Status</div>
              <span
                className="text-xs px-2 py-0.5 rounded font-medium"
                style={{
                  backgroundColor: status.halted
                    ? "color-mix(in srgb, var(--brand-danger) 12%, transparent)"
                    : "color-mix(in srgb, var(--brand-success) 12%, transparent)",
                  color: status.halted ? "var(--brand-danger)" : "var(--brand-success)",
                }}
              >
                {status.halted ? "HALTED" : "RUNNING"}
              </span>
            </div>
            {status.halted && status.reason && (
              <div className="w-full text-xs text-[var(--brand-danger)]">{status.reason}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
