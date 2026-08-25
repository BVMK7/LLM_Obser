# OpenTelemetry Export — Design

## Context

This is the third of four independent sub-projects originally bundled
under "Phase 4: Scalability" — Prometheus metrics and Data Retention &
Archival (the first two) are both done. Ingestion-time sampling and
Phase 5 (advanced evaluation) remain after this one.

This app has its own trace/span ingestion (`POST /spans`, the SDK) and
its own dashboard, and stays the system of record. This sub-project adds
a way to also see traces in external OTel-native tools (Jaeger,
Honeycomb, Grafana Tempo, any OTel-collector-based backend) by exporting
a copy of each completed trace as OTel spans. There is no ingestion path
in either direction beyond this app's existing SDK/`POST /spans`.

Four scope decisions, confirmed with the user before this was written:

- **Export only**, not ingestion and not both. This app never accepts
  OTLP data from anywhere; it only ever sends a copy of its own data out.
- **Background push to a per-project configured collector**, not an
  on-demand "give me this one trace as OTLP" endpoint — matches this
  app's existing per-project-opt-in + background-loop precedent
  (kill-switch webhook, incident webhook, retention sweep), and gives
  near-real-time visibility in the external tool rather than requiring a
  manual pull.
- **Hand-rolled OTLP/HTTP JSON, no new dependency.** The OTLP/HTTP JSON
  wire format is a documented, stable schema; building it directly with
  plain dicts and sending it with `httpx` (already a dependency, already
  used for the kill-switch/incident webhooks) avoids pulling in the full
  `opentelemetry-sdk` + exporter package tree for what is, at the code
  level, one outbound POST call. Same minimal-footprint reasoning Data
  Retention used to decline external blob storage.
- **60-second export loop**, not 24h like Retention's sweep — near-
  real-time visibility in the external tool is the actual point of this
  feature, so a 60s cadence (matching the online-scoring/incident loops)
  is the right default, not Retention's "archival is cheap to run
  rarely" reasoning.

## Data model

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS otel_collector_url TEXT;
-- NULL means "export disabled," same convention as retention_days/
-- kill_switch_webhook_url/incident_webhook_url on this same table.

ALTER TABLE traces ADD COLUMN IF NOT EXISTS otel_exported_at TIMESTAMPTZ;
-- NULL means "not yet exported." Set the moment this trace's export POST
-- succeeds — this is what makes the export loop idempotent: a trace only
-- stays eligible while this is NULL, so a retried tick (or a POST
-- failure that's naturally retried forever) can never send the same
-- trace twice.
```

## Trace → OTel span mapping

Each `Trace` becomes one **root span** with no parent. Each of the
trace's `Span` rows becomes a **child span**, parented to that root.

OTel's wire format needs a 128-bit hex `trace_id` and a 64-bit hex
`span_id`. This app's primary keys are already 128-bit UUIDs, so:

- `trace_id = trace.id.hex` (32 hex chars) — used as-is, no new ID
  scheme, no collision risk.
- `span_id` for any row = that row's own `id.hex[:16]` (16 hex chars).
  The trace's own root span isn't a separate database row, so it reuses
  `trace.id.hex[:16]` as its own span id — deterministic, and distinct
  from any child span's id (a different UUID's first 16 hex chars).

Attributes:

- **Root span** (the trace): `session_id`, `agent_id`, `model`,
  `total_tokens`, `cost` — only the ones that are non-NULL on that trace.
- **Child span** (each `Span` row): `step_name`, `input`, `output`,
  `failure_category` — only the ones that are non-NULL on that row. A
  span whose `error` column is set gets `status.code =
  "STATUS_CODE_ERROR"` and `status.message = error_explanation`; a span
  with no error gets no `status` field at all (OTLP's default,
  `STATUS_CODE_UNSET`, is the correct reading for "never failed," not an
  explicit "OK").
- **Resource**: `service.name` = the project's `name`.

This is a full-fidelity mapping of what this app already tracks, not a
summary — nothing about the original trace/span data is lossy, it's
just re-shaped into OTel's span/attribute vocabulary.

## Eligibility rule

A trace is exportable when **both**:

1. Its project has `otel_collector_url` set (export enabled).
2. `ended_at IS NOT NULL` (only completed traces — a still-in-progress
   trace has no meaningful end time to report) **and**
   `otel_exported_at IS NULL` (not already sent).

There is no analog of Retention's "skip if it has an open trace_flag"
rule here — export is a side-effect-free copy, never a deletion, so
there's nothing about an open Review Queue item that this needs to
protect.

## Export mechanism

One HTTP POST per project per tick, containing every eligible trace (up
to the batch cap) as one OTLP `resourceSpans` payload — not one POST per
trace, since batching per project per tick is both cheaper and the
natural unit OTLP's payload shape already expects (`resourceSpans` →
`scopeSpans` → `spans[]`, many spans per request).

1. Query every `Project` with `otel_collector_url IS NOT NULL`.
2. For each, query its eligible traces (the rule above), capped at
   `_OTEL_EXPORT_BATCH_SIZE = 100` per project per tick — same "bound the
   work per tick" precedent as every other loop in this app. A project
   with a bigger backlog just keeps shrinking it over later ticks.
3. Build the OTLP JSON payload and POST it (5s timeout, via `httpx`,
   same shape as the kill-switch/incident webhook senders).
4. On success, stamp `otel_exported_at = now()` on every trace just
   sent. On failure (network error, non-2xx), leave the marker unset —
   those traces are simply retried on the next tick, forever. No
   backoff: the batch cap already bounds the cost of a stuck collector.

## Trigger: a new background loop

`_otel_export_loop`, registered in `lifespan` alongside the existing
loops, on a 60-second interval (`_OTEL_EXPORT_INTERVAL_SECONDS = 60`) —
near-real-time visibility is the point, unlike Retention's 24h cadence.
Gets `record_loop_tick("otel_export", duration)` from the already-shipped
Prometheus work, same as every other loop.

## Project Settings UI

A new "OpenTelemetry Export" card, same shape and admin-gating as the
existing Kill-Switch/Data Retention cards: one URL text input (blank =
disabled), a Save button. Copy states plainly that this only sends a
copy of trace data out — this app stays the system of record either
way.

## Explicitly out of scope for this turn

- Any OTLP ingestion (accepting spans from an externally-instrumented
  app) — confirmed with the user as a separate, declined direction for
  this sub-project.
- The official `opentelemetry-sdk`/exporter packages — declined in favor
  of a hand-rolled OTLP/HTTP JSON payload, per the minimal-dependency
  decision above.
- Retry backoff, a failure counter, or a dead-letter concept for export
  failures — a failed export is simply retried forever on the next tick.
- Any change to this app's own dashboard/trace model — export is a
  read-only side effect of a trace completing; nothing about how traces
  are created, displayed, or queried in this app changes.

## Testing plan

New `tests/test_otel_export.py`, same live-server convention as every
other suite, calling `_run_otel_export_once` directly (same deliberate
exception `test_retention.py` already established, since the real loop
only ticks once per 60s) against a small local HTTP server standing in
for the collector:

- A completed trace with spans, once a project's `otel_collector_url` is
  set, gets exported: the collector receives one POST containing a root
  span (trace) and correctly-parented child spans (its Span rows), and
  `Trace.otel_exported_at` becomes non-NULL.
- A span with `error` set maps to `status.code = "STATUS_CODE_ERROR"` in
  its exported span.
- Running the export twice in a row only sends each trace once (the
  `otel_exported_at` marker prevents a re-send).
- A project with no `otel_collector_url` set never has any trace
  exported.
- A still-`pending` trace (`ended_at IS NULL`) is never exported
  regardless of age.
- A collector that's unreachable (POST fails) leaves the trace's
  `otel_exported_at` unset, proving the "retry forever, no backoff" rule.
