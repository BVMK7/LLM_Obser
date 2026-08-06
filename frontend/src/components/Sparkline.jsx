// Minimal inline sparkline — plain SVG, no charting library, matching the
// hand-rolled bar/track idiom already used by ProviderHeatmap/SpanTimeline.
// `values` should be real historical data in chronological order (e.g. a
// score across successive experiments) — this never fabricates points.
export default function Sparkline({ values, color = "var(--brand-primary)", width = 56, height = 20 }) {
  if (!values || values.length < 2) {
    return <svg width={width} height={height} />;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
