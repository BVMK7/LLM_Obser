// Labeled range input — used for temperature/top-p in the Playground config panel.
export default function Slider({ label, value, onChange, min, max, step }) {
  return (
    <div className="mb-4">
      <div className="flex justify-between text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
        <span>{label}</span>
        <span className="text-[var(--brand-success)] normal-case">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--brand-primary)]"
      />
    </div>
  );
}
