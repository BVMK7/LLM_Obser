// Shared colored status pill — used by Traces (success/error/pending) and
// Evaluation (passing/failing/ungraded).
const STYLES = {
  success: { label: "success", bg: "color-mix(in srgb, var(--brand-success) 12%, transparent)", color: "var(--brand-success)" },
  passing: { label: "passing", bg: "color-mix(in srgb, var(--brand-success) 12%, transparent)", color: "var(--brand-success)" },
  pass: { label: "pass", bg: "color-mix(in srgb, var(--brand-success) 12%, transparent)", color: "var(--brand-success)" },
  error: { label: "error", bg: "color-mix(in srgb, var(--brand-danger) 12%, transparent)", color: "var(--brand-danger)" },
  failing: { label: "failing", bg: "color-mix(in srgb, var(--brand-danger) 12%, transparent)", color: "var(--brand-danger)" },
  fail: { label: "fail", bg: "color-mix(in srgb, var(--brand-danger) 12%, transparent)", color: "var(--brand-danger)" },
  pending: { label: "pending", bg: "color-mix(in srgb, var(--brand-warning) 12%, transparent)", color: "var(--brand-warning)" },
  ungraded: { label: "ungraded", bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)", color: "var(--text-muted)" },
};

export default function StatusPill({ status }) {
  const style = STYLES[status] || STYLES.ungraded;
  return (
    <span
      className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {style.label}
    </span>
  );
}
