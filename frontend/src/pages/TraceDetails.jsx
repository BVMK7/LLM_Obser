import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getTrace, flagTrace, API_BASE } from "../api";
import StatusPill from "../components/StatusPill";
import MetricCard from "../components/MetricCard";
import CopyButton from "../components/CopyButton";
import Skeleton from "../components/Skeleton";
import SpanTimeline from "../components/SpanTimeline";
import { formatCost, formatDuration, formatTimestamp, formatTokens } from "../utils";

const TABS = ["Overview", "Timeline", "Metadata"];

function TraceDetailsSkeleton() {
  return (
    <div>
      <Skeleton className="h-3 w-24 mb-3" />
      <Skeleton className="h-7 w-64 mb-1" />
      <Skeleton className="h-4 w-48 mb-6" />
      <div className="flex gap-4 mb-6 flex-wrap">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 flex-1 min-w-[160px]">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}

function OverviewTab({ trace }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs uppercase text-[var(--text-muted)]">Input</div>
            {trace.input && <CopyButton text={trace.input} />}
          </div>
          <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{trace.input || "—"}</div>
        </div>
        <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs uppercase text-[var(--text-muted)]">Output</div>
            {trace.output && <CopyButton text={trace.output} />}
          </div>
          <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{trace.output || "—"}</div>
        </div>
      </div>
      {trace.scores.length > 0 && (
        <div>
          <div className="text-xs uppercase text-[var(--text-muted)] mb-2">Scores</div>
          <div className="flex gap-2 flex-wrap">
            {trace.scores.map((s) => (
              <span
                key={s.id}
                title={s.explanation || ""}
                className="text-xs px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-secondary)]"
              >
                {s.score_name === "user_feedback" ? (s.score_value >= 1 ? "👍" : "👎") : `${s.score_name}: ${s.score_value}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetadataTab({ trace }) {
  return (
    <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-4 flex flex-col gap-2 text-sm max-w-xl">
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Trace ID</span>
        <span className="text-[var(--text-primary)] text-right break-all">{trace.id}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Started At</span>
        <span className="text-[var(--text-primary)]">{trace.started_at}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--text-muted)]">Ended At</span>
        <span className="text-[var(--text-primary)]">{trace.ended_at || "—"}</span>
      </div>
      <div className="flex justify-between items-center gap-4">
        <span className="text-[var(--text-muted)]">Status</span>
        <StatusPill status={trace.status} />
      </div>
      <div className="flex justify-between items-center gap-4">
        <span className="text-[var(--text-muted)]">Flagged for Review</span>
        <span className="text-[var(--text-primary)]">{trace.flagged_for_review ? "Yes" : "No"}</span>
      </div>
      {trace.review_note && (
        <div className="flex justify-between gap-4">
          <span className="text-[var(--text-muted)]">Review Note</span>
          <span className="text-[var(--text-primary)] text-right">{trace.review_note}</span>
        </div>
      )}
    </div>
  );
}

export default function TraceDetails() {
  const { id } = useParams();
  const [trace, setTrace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("Overview");

  useEffect(() => {
    setLoading(true);
    setError(null);
    getTrace(id)
      .then(setTrace)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <TraceDetailsSkeleton />;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Couldn't reach the API at {API_BASE} — is it running/reachable, and is your API key valid? ({error})
      </div>
    );
  }

  if (!trace) return null;

  const handleToggleFlag = async () => {
    let review_note = trace.review_note;
    const flagging = !trace.flagged_for_review;
    if (flagging) {
      review_note = window.prompt("Note for the reviewer (optional):", trace.review_note || "") ?? trace.review_note;
    }
    try {
      const updated = await flagTrace(trace.id, { flagged_for_review: flagging, review_note: flagging ? review_note : null });
      setTrace({ ...trace, ...updated });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <Link to="/traces" className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        ← Back to Traces
      </Link>

      <div className="flex items-start justify-between mt-2 mb-1">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">{trace.name}</h1>
          <div className="text-xs text-[var(--text-muted)]">{trace.id}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggleFlag}
            className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
              trace.flagged_for_review
                ? "bg-[color-mix(in_srgb,var(--brand-warning)_15%,transparent)] text-[var(--brand-warning)]"
                : "bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
            }`}
          >
            {trace.flagged_for_review ? "🚩 Flagged for review" : "Flag for review"}
          </button>
          <StatusPill status={trace.status} />
        </div>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-6">{formatTimestamp(trace.started_at)}</p>

      <div className="flex gap-4 mb-6 flex-wrap">
        <MetricCard label="Duration" value={formatDuration(trace.started_at, trace.ended_at)} icon="⏱" />
        <MetricCard label="Tokens" value={formatTokens(trace.total_tokens)} icon="🗄" />
        <MetricCard label="Cost" value={formatCost(trace.cost)} icon="$" />
        <MetricCard label="Spans" value={trace.spans.length} icon="▤" />
      </div>

      <div className="flex gap-1 mb-4 border-b border-[var(--border-subtle)]">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-[var(--brand-primary)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4">
        {tab === "Overview" && <OverviewTab trace={trace} />}
        {tab === "Timeline" && <SpanTimeline trace={trace} />}
        {tab === "Metadata" && <MetadataTab trace={trace} />}
      </div>
    </div>
  );
}
