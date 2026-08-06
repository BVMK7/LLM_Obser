import { formatDuration, formatTimestamp } from "../utils";

// Builds a real parent/child tree from parent_span_id (e.g. an eval case's
// judge/scorer spans nest under the llm_call span they're judging — see
// main.py's _run_eval_case). Root spans (parent_span_id == null) come first,
// each followed depth-first by its children, so the flat array below still
// renders as a tree via per-row indentation.
function flattenSpanTree(spans) {
  const byParent = {};
  for (const span of spans) {
    const key = span.parent_span_id || "root";
    (byParent[key] ||= []).push(span);
  }
  const ordered = [];
  const visit = (parentKey, depth) => {
    for (const span of byParent[parentKey] || []) {
      ordered.push({ span, depth });
      visit(span.id, depth + 1);
    }
  };
  visit("root", 0);
  return ordered;
}

// Waterfall/Gantt view of a trace's real spans, positioned and sized by
// their actual started_at/ended_at relative to the trace's own window. The
// "Total Trace Duration" row is a synthetic full-width bar (not a real
// span) giving the same top-level reference row every span is measured
// against.
export default function SpanTimeline({ trace }) {
  if (!trace.ended_at) {
    return (
      <div className="text-sm text-[var(--text-muted)]">
        Timeline unavailable while this trace is still in progress.
      </div>
    );
  }
  if (trace.spans.length === 0) {
    return <div className="text-sm text-[var(--text-muted)]">This trace has no spans.</div>;
  }

  const traceStart = new Date(trace.started_at).getTime();
  const traceEnd = new Date(trace.ended_at).getTime();
  const totalMs = Math.max(1, traceEnd - traceStart);
  const rows = flattenSpanTree(trace.spans);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-[var(--text-primary)] font-medium">Total Trace Duration</span>
          <span className="text-[var(--text-muted)]">{formatDuration(trace.started_at, trace.ended_at)}</span>
        </div>
        <div className="h-2.5 bg-white/5 relative overflow-hidden">
          <div className="h-full absolute top-0 left-0 w-full" style={{ backgroundColor: "var(--brand-primary)" }} />
        </div>
      </div>

      {rows.map(({ span, depth }) => {
        const spanStart = new Date(span.started_at).getTime();
        const openEnded = !span.ended_at;
        const spanEnd = openEnded ? spanStart : new Date(span.ended_at).getTime();

        // Clamp to the trace's own window in case of clock skew (e.g. a
        // manually-posted span, or one still open when the trace closed).
        const clampedStart = Math.min(Math.max(spanStart, traceStart), traceEnd);
        const clampedEnd = Math.min(Math.max(spanEnd, traceStart), traceEnd);

        const offsetPct = ((clampedStart - traceStart) / totalMs) * 100;
        // Floor every bar's width so sub-100ms spans stay visible — exact
        // duration is in the label, not relied on from bar width alone.
        const widthPct = Math.max(1.5, ((clampedEnd - clampedStart) / totalMs) * 100);

        return (
          <div key={span.id} style={{ marginLeft: depth * 20 }}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[var(--text-secondary)]">
                {depth > 0 && <span className="text-[var(--text-muted)]">↳ </span>}
                {span.step_name}
              </span>
              <span className="text-[var(--text-muted)]">
                {openEnded ? "still open" : formatDuration(span.started_at, span.ended_at)}
              </span>
            </div>
            <div className="h-2 bg-white/5 relative overflow-hidden">
              <div
                className={`h-full absolute top-0 ${openEnded ? "opacity-50" : ""}`}
                style={{
                  left: `${offsetPct}%`,
                  width: `${widthPct}%`,
                  backgroundColor: span.error ? "var(--brand-danger)" : "var(--brand-success)",
                }}
                title={`${formatTimestamp(span.started_at)} → ${openEnded ? "in progress" : formatTimestamp(span.ended_at)}`}
              />
            </div>
            {span.error && <div className="text-xs text-[var(--brand-danger)] mt-1">error: {span.error}</div>}
          </div>
        );
      })}
    </div>
  );
}
