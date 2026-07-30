import { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { bucketByTime, TIME_RANGES } from "../utils";

// Splits each shared time bucket into success/error counts using the
// backend-computed `status` field, so the chart shows a real second series
// instead of an invented one.
function bucketTraces(traces, rangeKey) {
  return bucketByTime(traces, rangeKey).map(({ time, traces: bucketTraces }) => ({
    time,
    success: bucketTraces.filter((t) => t.status !== "error").length,
    error: bucketTraces.filter((t) => t.status === "error").length,
  }));
}

export default function RequestChart({ traces }) {
  const [range, setRange] = useState("24H");
  const data = useMemo(() => bucketTraces(traces, range), [traces, range]);

  return (
    <div>
      <div className="flex justify-end gap-1 mb-3">
        {Object.keys(TIME_RANGES).map((key) => (
          <button
            key={key}
            onClick={() => setRange(key)}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
              range === key
                ? "bg-[var(--brand-primary)] text-white"
                : "bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      {data.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No trace data in this range.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="fillSuccess" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand-success)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="var(--brand-success)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
            <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={12} tickLine={false} />
            <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: "var(--bg-card)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
              }}
              labelStyle={{ color: "var(--text-primary)" }}
            />
            <Area
              type="monotone"
              dataKey="success"
              name="Success"
              stroke="var(--brand-success)"
              fill="url(#fillSuccess)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="error"
              name="Error"
              stroke="var(--brand-danger)"
              strokeDasharray="4 4"
              fill="transparent"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
