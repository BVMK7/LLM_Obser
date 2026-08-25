# OpenTelemetry Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Newly-completed traces get automatically pushed, near-real-time, to a per-project OpenTelemetry collector as OTLP/HTTP JSON — each `Trace` becomes one root span, each of its `Span` rows becomes a child span — via a new 60-second background loop. Export only: this app stays the system of record, there is no OTLP ingestion anywhere in this codebase.

**Architecture:** Two new nullable columns (`Project.otel_collector_url`, `Trace.otel_exported_at`) plus a hand-rolled OTLP/HTTP JSON payload builder and a `httpx`-based sender, wired into a new background loop that follows this file's existing batch-loop shape exactly (same triple as `_run_retention_sweep_once`/`_retention_sweep_loop`, but 60s instead of 24h). A new Project Settings card exposes the URL setting.

**Tech Stack:** FastAPI, SQLAlchemy (Postgres), Pydantic, `httpx` (already a dependency — no new pip package), pytest against a live server (this repo's only testing convention — see `tests/conftest.py`). React/Vite frontend for the one settings card.

**Spec:** `docs/superpowers/specs/2026-08-25-otel-export-design.md` (written as Task 1, Step 1 of this plan — the design itself was already discussed and approved directly with the user in chat: export-only, background push, hand-rolled OTLP/HTTP JSON, no new dependency, and the exact data-model/mapping/ID-derivation/batch/retry decisions captured in Global Constraints below. Task 1 Step 1 is where that already-approved design gets written down as this repo's usual spec record, matching the Prometheus/Retention precedent, before the plan proceeds to implement it.)

## Global Constraints

- **Export only, no ingestion.** Nothing in this plan adds an OTLP receiver/endpoint. This app never accepts spans from anywhere else via OTel.
- **No new pip dependency.** Build the OTLP/HTTP JSON payload by hand (plain `dict`s). `httpx` is already in `requirements.txt` and already imported in `main.py` (line 21) — reuse it exactly the way `_send_kill_switch_webhook` does. Do **not** use `requests` (that package is test-only in this repo — see `tests/conftest.py`'s docstring — and has zero production usage in `main.py`).
- **60-second loop, not 24h.** Unlike Retention's 24h sweep, near-real-time visibility is the entire point of this feature. Interval constant = 60.
- **Batch cap per project per tick.** `_OTEL_EXPORT_BATCH_SIZE = 100` — same bounded-work-per-tick precedent as `_RETENTION_SWEEP_BATCH_SIZE`/`_ONLINE_SCORING_BATCH_SIZE`/`_INCIDENT_RECOVERY_BATCH_SIZE`. A project with a bigger backlog than this just keeps shrinking it over later ticks.
- **Retry semantics: no backoff, ever.** On any POST failure (network error or non-2xx), `Trace.otel_exported_at` is left `NULL`. That trace is naturally picked up again on the very next 60s tick, forever — the batch cap already bounds the cost of that. Do not add exponential backoff, a failure counter, or a dead-letter concept; none of that was approved.
- **Capture-ids-before-commit discipline (binding — this file has been bitten twice by this).** Every batch query's ORM objects must have their needed plain values (`id`, and anything else read in a `except`/log line) captured into plain Python variables **immediately after the query, before any per-item `db.commit()`** runs. Any subsequent logging or lookup — especially inside an `except` block — must use the captured plain value, never re-read the ORM attribute. This loop commits `otel_exported_at` per-trace (not once per batch at the end), so it must follow this discipline exactly like `_run_retention_sweep_once` does.
- **ID derivation is fixed, do not invent alternatives:** `trace_id = trace.id.hex` (32 hex chars). `span_id` for any row = that row's own `id.hex[:16]` (16 hex chars). The trace's own OTel root span (which isn't a separate DB row) reuses `trace.id.hex[:16]` as its own span id.
- **Mapping is fixed:** one root span per `Trace` (no `parentSpanId`) with attributes `session_id`/`agent_id`/`model`/`total_tokens`/`cost` (only the ones that are non-NULL); one child span per `Span` row (`parentSpanId` = the root's derived span id) with attributes `step_name`/`input`/`output`/`failure_category` (only the ones that are non-NULL); a child span whose `Span.error` is set gets `status.code = "STATUS_CODE_ERROR"` and `status.message = Span.error_explanation`. `resource.attributes["service.name"]` = the project's `name`.
- **Eligibility is fixed:** a trace is exportable once `ended_at IS NOT NULL` and `otel_exported_at IS NULL`, for any project whose `otel_collector_url IS NOT NULL`. There is no separate "review queue" or "open flag" safety rule here (that's Retention's rule, not this feature's — export never deletes anything, so there's nothing to protect against).
- This repo's only testing convention is live-server integration tests over real HTTP (no mocks, no in-process `TestClient`) — see `tests/conftest.py`'s docstring. The one deliberate exception, same class as `test_retention.py`'s: because the real loop only ticks once per 60s, tests import `_run_otel_export_once`/`SessionLocal` directly from `main` and call it synchronously. Do not modify `tests/conftest.py`. The "collector" side needs its own tiny local HTTP server (stdlib `http.server`, background thread) since a real collector is always an external system this app POSTs *to* — that helper lives in the new test file only, not in `conftest.py` (same precedent as `test_retention.py` keeping its own `_archived_row` DB helper local rather than promoting it).
- Migrations are plain root-level `.sql` files, idempotent (`ADD COLUMN IF NOT EXISTS`), applied via `.github/workflows/eval.yml`'s hardcoded ordered list — the last entry today is `add_data_retention.sql`.
- Nothing in this plan gets pushed to `origin/main` or deployed to Render on completion — per explicit standing instruction, this work (and the already-completed, uncommitted-to-origin Data Retention feature and `Experiment.results` bug fix) is held for one single batched push once every remaining roadmap phase is done.

---

### Task 1: Design spec + migration

**Files:**
- Create: `docs/superpowers/specs/2026-08-25-otel-export-design.md`
- Create: `add_otel_export.sql`
- Modify: `.github/workflows/eval.yml` (migration list, ~line 76)

**Interfaces:**
- Produces: `projects.otel_collector_url`, `traces.otel_exported_at` columns — Task 2's model changes map onto these exact names/types.

- [ ] **Step 1: Write the design spec doc**

Write `docs/superpowers/specs/2026-08-25-otel-export-design.md`, matching the structure of `docs/superpowers/specs/2026-08-18-data-retention-design.md` (Context, confirmed scope decisions, data model, mapping/mechanism, loop, UI, out-of-scope, testing plan):

```markdown
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
```

- [ ] **Step 2: Commit the spec**

```bash
git add docs/superpowers/specs/2026-08-25-otel-export-design.md
git commit -m "Add OpenTelemetry export design spec"
```

- [ ] **Step 3: Write the migration file**

```sql
-- add_otel_export.sql
-- OpenTelemetry export (push-only). A per-project opt-in collector URL
-- (NULL = disabled) plus a per-trace "already exported" marker, consumed
-- by a new 60s background loop — see main.py's
-- _run_otel_export_once/_otel_export_loop. This app never ingests OTLP;
-- it only POSTs to an external collector. See
-- docs/superpowers/specs/2026-08-25-otel-export-design.md.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS otel_collector_url TEXT;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS otel_exported_at TIMESTAMPTZ;
```

- [ ] **Step 4: Apply it to the local dev Postgres**

Run the same local-migration mechanism used for every prior migration in
this session (check `docker ps` for the actual Postgres container/db
name, or apply via `psql`/whatever connection this repo's local dev
Postgres already uses — match exactly how `add_data_retention.sql` was
applied locally earlier in this session).

Expected: both `ALTER TABLE` statements succeed with no errors.
Re-running the same file a second time must also succeed with no errors
(idempotency check, since `IF NOT EXISTS` is used).

- [ ] **Step 5: Add it to the CI migration list**

In `.github/workflows/eval.yml`, the line ending
`add_agentops_phase1.sql add_phase2_operational.sql add_phase3_incidents.sql add_data_retention.sql; do`
becomes:

```
                   add_agentops_phase1.sql add_phase2_operational.sql add_phase3_incidents.sql add_data_retention.sql add_otel_export.sql; do
```

- [ ] **Step 6: Commit**

```bash
git add add_otel_export.sql .github/workflows/eval.yml
git commit -m "Add OpenTelemetry export migration (projects.otel_collector_url, traces.otel_exported_at)"
```

---

### Task 2: Models, schemas, OTLP payload builder, sender, and the background loop

**Files:**
- Modify: `main.py` — `Project.otel_collector_url` column, `Trace.otel_exported_at` column, `ProjectResponse`/`ProjectUpdate` fields, new `_otel_unix_nano`/`_otel_root_span`/`_otel_child_span`/`_build_otel_export_payload`/`_send_otel_export`/`_run_otel_export_once`/`_otel_export_loop` functions, wired into `lifespan`.

**Interfaces:**
- Consumes: `Trace`, `Span`, `Project`, `record_loop_tick` from `metrics.py` (already imported into `main.py` at line 33), `httpx` (already imported at line 21).
- Produces: `_run_otel_export_once(db: Session) -> None` — Task 3's tests call this by exact name/signature, same precedent as `_run_retention_sweep_once`.

- [ ] **Step 1: Add the `Project.otel_collector_url` column**

In the existing `Project` class (currently ending with `retention_days = Column(Integer)` right after the "Data retention" comment block, `main.py:73-103`), add directly after it:

```python
    # OpenTelemetry export (push-only) — NULL means disabled. When set, the
    # otel export background loop POSTs newly-completed traces to this OTLP/
    # HTTP-JSON collector endpoint as they finish, same "NULL means off"
    # convention as kill_switch_webhook_url/incident_webhook_url above. This
    # app never ingests OTLP; it only ever POSTs out to whatever collector
    # this URL points at.
    otel_collector_url = Column(Text)
```

- [ ] **Step 2: Add the `Trace.otel_exported_at` column**

In the existing `Trace` class (`main.py:260-301`), directly after the `agent_id` column (right before the `spans`/`scores` relationship lines), add:

```python
    # Set the moment this trace's OTel export POST succeeds (see
    # _run_otel_export_once below) — NULL means "not yet exported." This is
    # what makes the export loop idempotent: a trace is only ever eligible
    # while this stays NULL, so a retried tick (or a POST failure that's
    # naturally retried forever) can never send the same trace twice.
    otel_exported_at = Column(DateTime(timezone=True))
```

- [ ] **Step 3: Add `ProjectResponse`/`ProjectUpdate` fields**

In `ProjectResponse` (`main.py:1099-1112`, currently ending with `retention_days: Optional[int] = None` before `model_config = ConfigDict(from_attributes=True)`), add:

```python
    otel_collector_url: Optional[str] = None
```

In `ProjectUpdate` (`main.py:1418-1430`, currently ending with `retention_days: Optional[int] = Field(default=None, ge=1)`), add:

```python
    otel_collector_url: Optional[str] = None
```

(Plain `Optional[str]`, no `Field(...)` constraint — matches `kill_switch_webhook_url`/`incident_webhook_url`'s shape exactly, not `retention_days`'s numeric constraint. `update_project` needs no code change — it already applies `body.model_dump(exclude_unset=True)` generically via `setattr`.)

- [ ] **Step 4: Add the OTLP payload-building helpers and the sender**

Place this block in `main.py` directly after `_retention_sweep_loop` ends (right after its final `await asyncio.sleep(_RETENTION_SWEEP_INTERVAL_SECONDS)` line, before the next banner comment):

```python
# ---------------------------------------------------------------------------
# OpenTelemetry export — a background loop that POSTs each newly-completed,
# not-yet-exported trace (plus its spans) to a per-project OTLP/HTTP JSON
# collector endpoint, as one root span (the trace) with the trace's own
# spans as its children. Export-only: this app never accepts OTLP itself,
# it only ever POSTs out. See `lifespan` for how this loop is started/
# stopped — same shape as _retention_sweep_loop above, just a 60s interval
# instead of 24h, since near-real-time visibility is the point here.
# ---------------------------------------------------------------------------

def _otel_unix_nano(dt: datetime) -> str:
    # OTLP JSON encodes int64 fields (including *UnixNano timestamps) as
    # strings, not JSON numbers, since JS/JSON numbers can't losslessly
    # hold a 64-bit nanosecond timestamp.
    return str(int(dt.timestamp() * 1_000_000_000))


# The trace's own OTel root span — not a separate DB row, so it reuses the
# trace's own id.hex[:16] truncation for its span_id (see the plan's ID
# derivation rule). Attributes are only the trace-level fields the design
# calls out; any that are NULL on this trace are simply omitted rather than
# sent as a null attribute value.
def _otel_root_span(trace: "Trace") -> dict:
    attributes = []
    if trace.session_id is not None:
        attributes.append({"key": "session_id", "value": {"stringValue": str(trace.session_id)}})
    if trace.agent_id is not None:
        attributes.append({"key": "agent_id", "value": {"stringValue": str(trace.agent_id)}})
    if trace.model is not None:
        attributes.append({"key": "model", "value": {"stringValue": trace.model}})
    if trace.total_tokens is not None:
        attributes.append({"key": "total_tokens", "value": {"intValue": str(trace.total_tokens)}})
    if trace.cost is not None:
        attributes.append({"key": "cost", "value": {"doubleValue": float(trace.cost)}})

    span = {
        "traceId": trace.id.hex,
        "spanId": trace.id.hex[:16],
        "name": trace.name,
        "startTimeUnixNano": _otel_unix_nano(trace.started_at),
        "attributes": attributes,
    }
    if trace.ended_at is not None:
        span["endTimeUnixNano"] = _otel_unix_nano(trace.ended_at)
    return span


# One child span per Span row, nested under the trace's root span via
# parentSpanId. status is only set when this row actually errored — an
# unset span.error means "no explicit status," which OTLP collectors treat
# as STATUS_CODE_UNSET, the correct default for a step that never failed.
def _otel_child_span(trace: "Trace", span: "Span") -> dict:
    attributes = [{"key": "step_name", "value": {"stringValue": span.step_name}}]
    if span.input is not None:
        attributes.append({"key": "input", "value": {"stringValue": span.input}})
    if span.output is not None:
        attributes.append({"key": "output", "value": {"stringValue": span.output}})
    if span.failure_category is not None:
        attributes.append({"key": "failure_category", "value": {"stringValue": span.failure_category}})

    result = {
        "traceId": trace.id.hex,
        "spanId": span.id.hex[:16],
        "parentSpanId": trace.id.hex[:16],
        "name": span.step_name,
        "startTimeUnixNano": _otel_unix_nano(span.started_at),
        "attributes": attributes,
    }
    if span.ended_at is not None:
        result["endTimeUnixNano"] = _otel_unix_nano(span.ended_at)
    if span.error:
        result["status"] = {"code": "STATUS_CODE_ERROR", "message": span.error_explanation}
    return result


# Builds the full OTLP/HTTP JSON request body for ONE trace. project_name is
# passed as a plain string (not the Project ORM object) so this function
# never needs to touch a possibly-expired Project instance — the caller
# (_run_otel_export_once) already captured it up front per the
# capture-before-commit discipline. trace.spans triggers SQLAlchemy's lazy
# load the first time it's accessed, same as every other read of this
# relationship elsewhere in this file.
def _build_otel_export_payload(project_name: str, trace: "Trace") -> dict:
    spans = [_otel_root_span(trace)]
    spans.extend(_otel_child_span(trace, span) for span in trace.spans)
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": project_name}},
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "llm-observability"},
                        "spans": spans,
                    }
                ],
            }
        ]
    }


# Synchronous POST to the collector — same shape as _send_kill_switch_webhook
# above: httpx.Client (never `requests`, which is test-only in this repo),
# 5s timeout, raise_for_status, bare print-based error logging (no
# structured logger exists anywhere in this file). Returns True/False rather
# than raising, so the caller decides what "failed" means for
# otel_exported_at (see _run_otel_export_once).
def _send_otel_export(url: str, payload: dict) -> bool:
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
        return True
    except Exception as e:
        print(f"[otel-export] POST to {url!r} failed: {e}")
        return False


# Bounds work per project per tick — same precedent as
# _RETENTION_SWEEP_BATCH_SIZE/_ONLINE_SCORING_BATCH_SIZE. A project with a
# bigger backlog than this just keeps shrinking it over later ticks.
_OTEL_EXPORT_BATCH_SIZE = 100


def _run_otel_export_once(db: Session) -> None:
    projects = db.query(Project).filter(Project.otel_collector_url.isnot(None)).all()
    # Captured up front, before any per-trace commit() below can expire
    # these ORM objects (SQLAlchemy's default expire_on_commit=True) — same
    # capture-before-commit discipline as _run_retention_sweep_once. Project
    # NAME is captured here too (not just id/url) so _build_otel_export_payload
    # never has to read project.name off a possibly-expired instance.
    project_infos = [(project.id, project.otel_collector_url, project.name) for project in projects]
    for project_id, collector_url, project_name in project_infos:
        try:
            eligible = (
                db.query(Trace)
                .filter(
                    Trace.project_id == project_id,
                    Trace.ended_at.isnot(None),
                    Trace.otel_exported_at.is_(None),
                )
                .limit(_OTEL_EXPORT_BATCH_SIZE)
                .all()
            )
            # Captured up front, before this loop's own per-trace commit()
            # can expire these ORM objects — the except block below logs
            # this plain value, never trace.id, so a POST failure's log
            # line can never itself raise ObjectDeletedError.
            trace_ids = [trace.id for trace in eligible]
            for trace, trace_id in zip(eligible, trace_ids):
                try:
                    payload = _build_otel_export_payload(project_name, trace)
                    if _send_otel_export(collector_url, payload):
                        trace.otel_exported_at = datetime.now(timezone.utc)
                        db.commit()
                    # On failure, otel_exported_at is left unset (NULL) — this
                    # same trace is naturally retried on the next 60s tick,
                    # forever. No backoff needed: the batch cap above already
                    # bounds how much repeated work a stuck collector can cost.
                except Exception as e:
                    db.rollback()
                    print(f"[otel-export] failed exporting trace {trace_id}: {e}")
        except Exception as e:
            db.rollback()
            print(f"[otel-export] failed processing project {project_id}: {e}")


_OTEL_EXPORT_INTERVAL_SECONDS = 60  # near-real-time visibility is the point — unlike the 24h retention sweep


async def _otel_export_loop():
    while True:
        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_otel_export_once, db)
        except Exception as e:
            print(f"[otel-export] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("otel_export", time.perf_counter() - tick_start)
        await asyncio.sleep(_OTEL_EXPORT_INTERVAL_SECONDS)
```

- [ ] **Step 5: Wire it into `lifespan`**

Change (`main.py:1130-1134`):

```python
    background_tasks = [
        asyncio.create_task(_online_scoring_loop()),
        asyncio.create_task(_alert_notification_loop()),
        asyncio.create_task(_retention_sweep_loop()),
    ]
```

to:

```python
    background_tasks = [
        asyncio.create_task(_online_scoring_loop()),
        asyncio.create_task(_alert_notification_loop()),
        asyncio.create_task(_retention_sweep_loop()),
        asyncio.create_task(_otel_export_loop()),
    ]
```

- [ ] **Step 6: Verify it imports cleanly**

Run: `python -m py_compile main.py && python -c "import main; print(main._run_otel_export_once, main._build_otel_export_payload, main._send_otel_export)"`

Expected: prints the three function references, no traceback.

- [ ] **Step 7: Start the server and confirm no startup regression**

Kill anything on port 8010, then start `python -m uvicorn main:app --port 8010` (not `--reload`). Confirm `GET /docs` returns 200 and the startup log shows no traceback (the new loop starting is silent by design, same as the other loops — nothing prints on a clean start).

- [ ] **Step 8: Commit**

```bash
git add main.py
git commit -m "Add OpenTelemetry export: model columns, OTLP payload builder, and background loop"
```

---

### Task 3: Test suite

**Files:**
- Create: `tests/test_otel_export.py`

**Interfaces:**
- Consumes: `admin_headers`, `project`, `api_headers` fixtures (existing, `tests/conftest.py`, unchanged); `SessionLocal`, `_run_otel_export_once` imported directly from `main`.

**Note on approach:** same deliberate exception as `test_retention.py` — the real loop ticks every 60s, which is testable by polling in principle, but calling `_run_otel_export_once` directly is faster and deterministic. The "collector" this test POSTs to is a real thing an external system would run, so tests stand up a tiny local HTTP server (stdlib `http.server`, on a background thread, bound to an OS-assigned port via `("127.0.0.1", 0)`) to capture and assert on the POSTed payload, then point `Project.otel_collector_url` at it via the real `PATCH /projects/{id}` endpoint.

Note: the `project` fixture (`tests/conftest.py`) yields only `{"id": ..., "api_key": ...}` — it does NOT expose the project's `name`. Do not assert against a specific project-name string; assert only that the `service.name` resource attribute is present and non-empty (see Step 1's first test below).

- [ ] **Step 1: Write the test file**

```python
"""
Integration tests for OpenTelemetry export. Traces/spans/settings go
through the real API; the export loop itself (which only ticks once per
60s in the running server) is invoked directly rather than waited for —
same deliberate, narrow exception to this repo's live-server-HTTP-only
testing convention as tests/test_retention.py's _run_retention_sweep_once.

The "collector" side is a tiny local HTTP server (stdlib http.server) run
on a background thread for the duration of each test — a real OTel
collector is always an external HTTP receiver this app POSTs *to*, so a
local stand-in is the only way to capture and assert on the payload shape
without depending on any real collector being reachable.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests
from sqlalchemy import text

from main import SessionLocal, _run_otel_export_once

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _patch(path, headers, body=None):
    resp = requests.patch(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _set_otel_collector_url(admin_headers, project_id, url):
    requests.patch(
        f"{BACKEND_URL}/projects/{project_id}", headers=admin_headers,
        json={"name": "otel-export-test", "otel_collector_url": url},
    ).raise_for_status()


def _exported_at(trace_id):
    db = SessionLocal()
    try:
        return db.execute(
            text("SELECT otel_exported_at FROM traces WHERE id = :id"),
            {"id": str(trace_id)},
        ).scalar()
    finally:
        db.close()


class _MockCollector:
    """A minimal local stand-in for an OTLP/HTTP collector — captures every
    POSTed JSON body so a test can assert on its shape, and always answers
    200 OK so _send_otel_export's raise_for_status() never trips."""

    def __init__(self):
        self.received = []
        received = self.received

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                received.append(json.loads(body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, fmt, *args):
                pass  # silence default per-request stderr logging

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self):
        host, port = self._server.server_address
        return f"http://{host}:{port}/v1/traces"

    def shutdown(self):
        self._server.shutdown()
        self._thread.join(timeout=5)


@pytest.fixture
def mock_collector():
    collector = _MockCollector()
    yield collector
    collector.shutdown()


def test_completed_trace_gets_exported_and_marked(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)

    trace = _post("/traces", api_headers, {"name": "otel_trace", "model": "gpt-x", "total_tokens": 42, "cost": 0.01})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "llm_call", "input": "hi", "output": "hello"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert len(mock_collector.received) == 1
    payload = mock_collector.received[0]
    resource_attrs = payload["resourceSpans"][0]["resource"]["attributes"]
    service_name_attr = next(a for a in resource_attrs if a["key"] == "service.name")
    assert isinstance(service_name_attr["value"]["stringValue"], str) and service_name_attr["value"]["stringValue"]

    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    assert len(spans) == 2  # root (trace) + 1 child (span)

    trace_id_hex = uuid.UUID(trace["id"]).hex
    root = next(s for s in spans if "parentSpanId" not in s)
    child = next(s for s in spans if "parentSpanId" in s)
    assert root["traceId"] == trace_id_hex
    assert root["spanId"] == trace_id_hex[:16]
    assert child["parentSpanId"] == trace_id_hex[:16]
    attr_keys = {a["key"] for a in root["attributes"]}
    assert {"model", "total_tokens", "cost"} <= attr_keys

    assert _exported_at(trace["id"]) is not None


def test_span_error_maps_to_error_status(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)

    trace = _post("/traces", api_headers, {"name": "otel_error_trace"})
    span = _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "risky_call"})
    _patch(f"/spans/{span['id']}", api_headers, {"error": "boom", "ended_at": _now_iso()})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    payload = mock_collector.received[0]
    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    errored = next(s for s in spans if "parentSpanId" in s)
    assert errored["status"]["code"] == "STATUS_CODE_ERROR"


def test_trace_is_not_reexported_on_a_second_tick(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)
    trace = _post("/traces", api_headers, {"name": "otel_once_trace"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
        _run_otel_export_once(db)
    finally:
        db.close()

    assert len(mock_collector.received) == 1


def test_no_collector_url_never_exports(admin_headers, project, api_headers, mock_collector):
    # project fixture's default has otel_collector_url unset (NULL) — never
    # pointed at mock_collector at all, so any POST here would be a bug.
    trace = _post("/traces", api_headers, {"name": "otel_disabled_trace"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert mock_collector.received == []
    assert _exported_at(trace["id"]) is None


def test_pending_trace_is_not_exported(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)
    trace = _post("/traces", api_headers, {"name": "otel_pending_trace"})
    # Deliberately never PATCHed with ended_at — stays "pending".

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert mock_collector.received == []
    assert _exported_at(trace["id"]) is None


def test_collector_failure_leaves_trace_unexported_for_retry(admin_headers, project, api_headers):
    # Point at a port nothing is listening on — the POST fails, so
    # otel_exported_at must stay NULL, letting the next tick retry forever
    # (no backoff, per the approved design).
    _set_otel_collector_url(admin_headers, project["id"], "http://127.0.0.1:1/nowhere")
    trace = _post("/traces", api_headers, {"name": "otel_unreachable_trace"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert _exported_at(trace["id"]) is None
```

- [ ] **Step 2: Run the new tests in isolation**

Run: `python -m pytest tests/test_otel_export.py -v`

Expected: some failures on the first run would not be unusual — fix in place per the next step, don't move on with red tests.

- [ ] **Step 3: Fix any failures**

Common ones to check first: a 404/422 on `PATCH /projects/{id}` (compare `otel_collector_url` field name against Task 2's exact schema field), the mock collector never receiving a POST (check the eligibility filter in `_run_otel_export_once` matches exactly, and that the local server actually bound and started before the sweep runs), or a `KeyError`/`AssertionError` on the payload shape (compare against `_build_otel_export_payload`/`_otel_root_span`/`_otel_child_span` exactly). Iterate until every test in this file passes.

- [ ] **Step 4: Run the full suite to check for regressions**

Run the full suite properly tracked in the background (this repo's session convention — Windows stdout buffering makes a manually-tailed redirected log falsely look stalled for many minutes on a run this long; always use a properly-tracked background execution instead), and wait for it to actually finish before proceeding:

`python -u -m pytest tests/ -v`

Expected: all pre-existing tests (Phase 1/2/3, Prometheus metrics, Retention, the new `test_experiments.py`) still pass, plus the 6 new OTel export tests (43 total). This takes 10+ minutes — let it run to completion, do not assume completion from a log file that merely looks quiet.

- [ ] **Step 5: Commit**

```bash
git add tests/test_otel_export.py
git commit -m "Add OpenTelemetry export test suite"
```

---

### Task 4: Project Settings UI

**Files:**
- Modify: `frontend/src/pages/ProjectSettings.jsx`

**Interfaces:**
- Consumes: `updateProject` (existing, from `../api`), `otel_collector_url` field on the project object returned by `getProjects()` (already flows through automatically once Task 2's `ProjectResponse` change is live).

- [ ] **Step 1: Add the draft helper**

Directly after the existing `retentionDraftFrom` function (`ProjectSettings.jsx`, ends at line 41):

```jsx
function otelDraftFrom(project) {
  return {
    otel_collector_url: project.otel_collector_url ?? "",
  };
}
```

- [ ] **Step 2: Add state hooks**

Directly after the existing `retentionSaved` state hook (line 63):

```jsx
  const [otelDraft, setOtelDraft] = useState(otelDraftFrom({}));
  const [otelSaving, setOtelSaving] = useState(false);
  const [otelSaved, setOtelSaved] = useState(false);
```

- [ ] **Step 3: Populate the draft on load**

In `loadAll`, directly after the existing `setRetentionDraft(retentionDraftFrom(project));` line (line 96):

```jsx
        setOtelDraft(otelDraftFrom(project));
```

- [ ] **Step 4: Add the save handler**

Directly after the existing `handleRetentionSave` function (ends at line 177):

```jsx
  // otel_collector_url is a URL (not a number), so this follows the
  // kill-switch webhook handler's ".trim() || null" string-clearing
  // convention, not the retention field's numeric conversion.
  const handleOtelSave = (e) => {
    e.preventDefault();
    setOtelSaving(true);
    setOtelSaved(false);
    setError(null);
    updateProject(id, {
      name: projectName,
      otel_collector_url: otelDraft.otel_collector_url.trim() || null,
    })
      .then(() => setOtelSaved(true))
      .catch((err) => setError(err.message))
      .finally(() => setOtelSaving(false));
  };
```

(If, on reading the file, the existing `kill_switch_webhook_url` save handler uses a different exact string-clearing expression than `.trim() || null`, match that existing handler's exact expression instead — the point is consistency with whichever URL-field handler already exists in this file, not this snippet verbatim.)

- [ ] **Step 5: Add the settings card**

Insert directly between the existing "Data Retention" card's closing `</div>` (line 525) and the `{/* Billing */}` comment (line 527):

```jsx
        {/* OpenTelemetry Export */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-1">OpenTelemetry Export</div>
          <p className="text-xs text-[var(--text-muted)] mb-3">
            When set, every newly-completed trace (and its spans) is pushed to this OTLP/HTTP collector endpoint
            within about a minute of finishing. This app stays the system of record either way — this only sends a
            copy out. Leave blank to disable.
          </p>
          {!isAdmin ? (
            <div className="text-xs text-[var(--text-muted)]">Only admins can view or change OpenTelemetry export.</div>
          ) : (
            <form onSubmit={handleOtelSave} className="flex flex-col gap-2">
              <label className="block text-xs text-[var(--text-muted)]">Collector URL</label>
              <input
                type="url"
                placeholder="https://collector.example.com/v1/traces"
                value={otelDraft.otel_collector_url}
                onChange={(e) => setOtelDraft((d) => ({ ...d, otel_collector_url: e.target.value }))}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
              />
              <button
                type="submit"
                disabled={otelSaving}
                className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50 mt-1"
              >
                {otelSaving ? "Saving..." : otelSaved ? "Saved" : "Save OpenTelemetry Export"}
              </button>
            </form>
          )}
        </div>

```

(Note the blank line before `{/* Billing */}` — matches the existing spacing pattern between every other card in this file.)

- [ ] **Step 6: Manual smoke test**

Point `frontend/.env`'s `VITE_API_BASE` at `http://localhost:8010` (the local backend from Task 2), restart the Vite dev server, log in, navigate to a project's Settings page, confirm the "OpenTelemetry Export" card renders between "Data Retention" and "Billing" with the same visual shape as the other cards, enter a URL, save, reload the page, and confirm the value persisted. Check the browser console for errors. Restore `VITE_API_BASE` to the Render URL afterward and restart the Vite dev server again.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/ProjectSettings.jsx
git commit -m "Add OpenTelemetry Export card to Project Settings"
```

---

### Task 5: Final regression pass

**Files:** none (verification only).

- [ ] **Step 1: Full clean-restart regression run**

Restart the local backend fresh (kill any zombie process on port 8010 first), confirm the Task 1 migration is applied, then run the full suite properly tracked in the background (never a manually-tailed redirected log — see Task 3 Step 4's note) and wait for actual completion:

`python -u -m pytest tests/ -v`

Expected: 100% pass — proves Task 2's additions (new columns, new loop registered in `lifespan`, new schema fields) didn't regress anything already covered.

- [ ] **Step 2: Confirm the Prometheus tie-in by direct inspection**

Re-read the `_otel_export_loop` function from Task 2, Step 4 and confirm `record_loop_tick("otel_export", time.perf_counter() - tick_start)` is present in its `finally` block, at the same position as the equivalent line in `_retention_sweep_loop`/`_online_scoring_loop`. Optionally confirm live: hit `GET /metrics` on the running server and check for a `background_loop_last_run_timestamp_seconds{loop_name="otel_export"}` line with a recent timestamp (this loop ticks every 60s, so waiting up to ~65s for it to first appear is reasonable, unlike Retention's 24h tick).

- [ ] **Step 3: `git status` sanity check**

Run: `git status --short`

Expected: clean — nothing left uncommitted from Tasks 1-4.

- [ ] **Step 4: Report completion**

Summarize what shipped (per-project opt-in OTel collector URL, hand-rolled OTLP/HTTP JSON export of each newly-completed trace and its spans via a new 60s background loop, retry-forever-no-backoff semantics, the Project Settings card) and that nothing has been pushed/deployed yet — per the standing instruction to batch this together with Data Retention, the `Experiment.results` fix, and whatever Phase 5/Sampling produce into one push at the end.

---

### Critical Files for Implementation

- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\main.py` — `Project`/`Trace` model columns, `ProjectResponse`/`ProjectUpdate` schema fields, the new OTLP payload builder/sender/loop functions, `lifespan` wiring
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\add_otel_export.sql` — new migration (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\.github\workflows\eval.yml` — CI migration list ordering
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\tests\test_otel_export.py` — new test suite with the local mock-collector HTTP server (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\pages\ProjectSettings.jsx` — new "OpenTelemetry Export" settings card
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\docs\superpowers\specs\2026-08-25-otel-export-design.md` — design spec (to be created, Task 1)
