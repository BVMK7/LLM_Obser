import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getTraces, getTrace, API_BASE } from "../api";
import StatusPill from "../components/StatusPill";
import MetricCard from "../components/MetricCard";
import Skeleton from "../components/Skeleton";
import CopyButton from "../components/CopyButton";
import SpanTimeline from "../components/SpanTimeline";
import {
  formatCost,
  formatDuration,
  formatTokens,
  formatTimestamp,
  extractProvider,
  percentile,
  toCSV,
  downloadFile,
} from "../utils";

const PAGE_SIZE = 10;

function TracesSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4" style={{ minHeight: 420 }}>
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5">
          <Skeleton className="h-6 w-64 mb-4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}

export default function Traces() {
  const [traces, setTraces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const providerFilter = searchParams.get("provider") || "all";
  const statusFilter = useMemo(
    () => new Set((searchParams.get("status") || "").split(",").filter(Boolean)),
    [searchParams]
  );
  const providerOptions = useMemo(
    () => Array.from(new Set(traces.map((t) => extractProvider(t.name)))).sort(),
    [traces]
  );

  const setProviderFilter = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("provider");
    else next.set("provider", value);
    setSearchParams(next);
  };

  const toggleStatusFilter = (status) => {
    const current = new Set(statusFilter);
    if (current.has(status)) current.delete(status);
    else current.add(status);
    const next = new URLSearchParams(searchParams);
    if (current.size === 0) next.delete("status");
    else next.set("status", Array.from(current).join(","));
    setSearchParams(next);
  };
  // Free-text search lives in the Topbar (see components/Topbar.jsx) and is
  // shared here via the same URL-search-param pattern as the provider/status filters.
  const searchQuery = (searchParams.get("q") || "").trim().toLowerCase();
  const [page, setPage] = useState(1);

  // Reset to page 1 whenever any filter (provider, status, or search) changes.
  const searchParamsKey = searchParams.toString();
  useEffect(() => {
    setPage(1);
  }, [searchParamsKey]);

  // Load the trace list once on mount. If we arrived via a deep-link from
  // Overview (?trace=<id>), select that trace; otherwise default to the first.
  useEffect(() => {
    getTraces()
      .then((data) => {
        setTraces(data);
        const requestedId = searchParams.get("trace");
        if (requestedId && data.some((t) => t.id === requestedId)) {
          setSelectedId(requestedId);
        } else if (data.length > 0) {
          setSelectedId(data[0].id);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the selected trace changes, fetch its full detail (including spans).
  useEffect(() => {
    if (!selectedId) return;
    getTrace(selectedId)
      .then(setSelectedTrace)
      .catch((err) => setError(err.message));
  }, [selectedId]);

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (providerFilter !== "all" && extractProvider(t.name) !== providerFilter) return false;
      if (statusFilter.size > 0 && !statusFilter.has(t.status)) return false;
      if (searchQuery) {
        const haystack = `${t.name} ${t.input || ""} ${t.output || ""}`.toLowerCase();
        if (!haystack.includes(searchQuery)) return false;
      }
      return true;
    });
  }, [traces, providerFilter, statusFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const durations = traces.filter((t) => t.ended_at).map((t) => new Date(t.ended_at) - new Date(t.started_at));
  const globalP95 = percentile(durations, 0.95);
  const totalTokensLogged = traces.reduce((s, t) => s + (t.total_tokens || 0), 0);
  const costEstimate = traces.reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const successRate = traces.length
    ? Math.round((traces.filter((t) => t.status === "success").length / traces.length) * 100)
    : 0;

  const handleExportCSV = () =>
    downloadFile(
      "traces.csv",
      toCSV(
        filtered.map((t) => ({
          name: t.name,
          provider: extractProvider(t.name),
          started_at: t.started_at,
          duration_ms: t.ended_at ? new Date(t.ended_at) - new Date(t.started_at) : "",
          tokens: t.total_tokens || 0,
          cost: t.cost || 0,
          status: t.status,
        }))
      ),
      "text/csv"
    );

  if (loading) {
    return <TracesSkeleton />;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Couldn't reach the API at {API_BASE} — is it running/reachable, and is your API key valid? ({error})
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Trace Explorer</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            title="Export filtered traces as CSV"
            disabled={filtered.length === 0}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-30"
          >
            ⭳
          </button>
        </div>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-4">
        Real-time deep-dive into LLM traces, span waterfalls, and token-level economics.
      </p>

      <div className="flex flex-wrap items-center gap-4 mb-4 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--text-muted)]">Provider</label>
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          >
            <option value="all">All Providers</option>
            {providerOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--text-muted)]">Status</label>
          <div className="flex gap-2">
            {["success", "error"].map((status) => (
              <button
                key={status}
                onClick={() => toggleStatusFilter(status)}
                className={`text-xs px-2.5 py-1 rounded-lg border capitalize transition-colors ${
                  statusFilter.has(status)
                    ? "border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[color-mix(in_srgb,var(--brand-primary)_8%,transparent)]"
                    : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-4 mb-6" style={{ minHeight: 420 }}>
        {/* Left: list of traces */}
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 flex flex-col">
          <div className="flex-1 overflow-y-auto">
            {pageItems.map((trace) => (
              <button
                key={trace.id}
                onClick={() => setSelectedId(trace.id)}
                className={`w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors ${
                  trace.id === selectedId ? "bg-[var(--brand-primary)]" : "hover:bg-white/5"
                }`}
              >
                <div className={`text-sm truncate ${trace.id === selectedId ? "text-white" : "text-[var(--text-primary)]"}`}>
                  {trace.name}
                </div>
                <div
                  className={`text-xs flex items-center gap-2 mt-0.5 ${
                    trace.id === selectedId ? "text-white/70" : "text-[var(--text-muted)]"
                  }`}
                >
                  {formatTimestamp(trace.started_at)}
                  <StatusPill status={trace.status} />
                </div>
              </button>
            ))}
            {filtered.length === 0 && traces.length === 0 && (
              <div className="text-sm text-[var(--text-muted)] p-3">
                No traces yet.{" "}
                <Link to="/playground" className="text-[var(--brand-primary)] hover:underline">
                  Go to Playground
                </Link>{" "}
                to create your first one.
              </div>
            )}
            {filtered.length === 0 && traces.length > 0 && (
              <div className="text-sm text-[var(--text-muted)] p-3">No traces match these filters.</div>
            )}
          </div>

          {filtered.length > 0 && (
            <div className="px-2 pt-2 mt-2 border-t border-[var(--border-subtle)]">
              <div className="text-xs text-[var(--text-muted)] mb-2">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of{" "}
                {filtered.length} traces
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="text-xs px-1.5 text-[var(--text-muted)] disabled:opacity-30"
                  >
                    ‹
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`text-xs w-6 h-6 rounded transition-colors ${
                        p === page
                          ? "bg-[var(--brand-primary)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="text-xs px-1.5 text-[var(--text-muted)] disabled:opacity-30"
                  >
                    ›
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: detail for the selected trace */}
        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5 overflow-y-auto">
          {!selectedTrace ? (
            <div className="text-[var(--text-muted)]">Select a trace to inspect it.</div>
          ) : (
            <>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">{selectedTrace.name}</h2>
                  <div className="text-xs text-[var(--text-muted)] flex items-center gap-2">
                    {selectedTrace.id}
                    <Link to={`/traces/${selectedTrace.id}`} className="text-[var(--brand-primary)] hover:underline">
                      View Full Details ↗
                    </Link>
                  </div>
                </div>
                <div className="flex gap-4 text-sm items-center">
                  <StatusPill status={selectedTrace.status} />
                  <div>
                    <div className="text-xs text-[var(--text-muted)]">Duration</div>
                    <div className="text-[var(--text-primary)]">
                      {formatDuration(selectedTrace.started_at, selectedTrace.ended_at)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--text-muted)]">Tokens</div>
                    <div className="text-[var(--text-primary)]">{formatTokens(selectedTrace.total_tokens)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--text-muted)]">Cost</div>
                    <div className="text-[var(--text-primary)]">{formatCost(selectedTrace.cost)}</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs uppercase text-[var(--text-muted)]">Input</div>
                    {selectedTrace.input && <CopyButton text={selectedTrace.input} />}
                  </div>
                  <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                    {selectedTrace.input || "—"}
                  </div>
                </div>
                <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs uppercase text-[var(--text-muted)]">Output</div>
                    {selectedTrace.output && <CopyButton text={selectedTrace.output} />}
                  </div>
                  <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                    {selectedTrace.output || "—"}
                  </div>
                </div>
              </div>

              <div className="text-sm font-medium text-[var(--text-primary)] mb-2">
                Spans ({selectedTrace.spans.length})
              </div>
              {selectedTrace.spans.length > 0 && (
                <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3 mb-3">
                  <div className="text-xs uppercase text-[var(--text-muted)] mb-2">Span Timeline</div>
                  <SpanTimeline trace={selectedTrace} />
                </div>
              )}
              <div className="flex flex-col gap-2">
                {selectedTrace.spans.map((span) => (
                  <div key={span.id} className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm text-[var(--brand-primary)]">{span.step_name}</span>
                      <span className="text-xs text-[var(--text-muted)]">
                        {formatDuration(span.started_at, span.ended_at)}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--text-secondary)] mb-1">
                      <span className="text-[var(--text-muted)]">in:</span> {span.input || "—"}
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      <span className="text-[var(--text-muted)]">out:</span> {span.output || "—"}
                    </div>
                    {span.error && (
                      <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                        <div className="text-xs text-[var(--brand-danger)] mb-1">error: {span.error}</div>
                        {span.error_explanation && (
                          <div className="text-xs text-[var(--text-secondary)]">{span.error_explanation}</div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {selectedTrace.spans.length === 0 && (
                  <div className="text-sm text-[var(--text-muted)]">This trace has no spans.</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-4 flex-wrap">
        <MetricCard
          label="Global P95 Latency"
          value={globalP95 != null ? `${Math.round(globalP95)}ms` : "—"}
          icon="⏱"
        />
        <MetricCard label="Total Tokens Logged" value={formatTokens(totalTokensLogged)} icon="🗄" />
        <MetricCard label="Cost Estimate" value={formatCost(costEstimate)} icon="$" />
        <MetricCard
          label="Success Rate"
          value={`${successRate}%`}
          progress={successRate}
          icon="✓"
          accent="primary"
        />
      </div>
    </div>
  );
}
