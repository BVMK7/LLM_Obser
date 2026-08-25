# Data Retention & Archival — Design

## Context

This is the second of four independent sub-projects originally bundled
under "Phase 4: Scalability" — OpenTelemetry integration, ingestion-time
sampling, and Phase 5 (advanced evaluation) are each their own scope and
are NOT covered here. The Prometheus metrics endpoint (the first
sub-project) already shipped and is deployed.

Today, `traces`/`spans`/`scores`/`trace_flags` grow completely unbounded
in Postgres — nothing ever removes a row. This adds a per-project,
opt-in retention window: traces older than the window get archived (a
compact historical snapshot) and then deleted from the live tables.

**What this does and doesn't fix.** Because the archive lives in the
same Postgres database (see the destination decision below), total row
count and disk usage are NOT bounded by this feature — one
`archived_traces` row replaces the several normalized rows a trace used
to occupy, but nothing is ever deleted from Postgres for good. What this
actually buys: a much smaller *hot* working set — `GET /traces`,
Overview/Performance/Cost & Usage, and alert-rule evaluation all read
only live traces, so they get faster and index bloat drops as a
project's history grows — plus Postgres' own TOAST compression on the
JSONB archive rows. If unbounded *disk* growth is ever the actual
problem, that's a different feature (external cold storage, or a real
delete-without-archiving retention tier), not this one.

Four scope decisions, confirmed with the user before this was written:

- **Archive first, then delete** (not a bare delete, not a soft-delete-
  only that leaves the live tables unbounded).
- **Archive destination: the same Postgres database**, a new compact
  table — not external object storage. This app is otherwise entirely
  free-tier/self-hosted with no blob storage already configured, so
  introducing one now would be a real, unrequested increase in
  operational surface.
- **Per-project, not global** — a new `Project.retention_days` field,
  matching the existing `kill_switch_webhook_url`/
  `incident_automation_enabled` pattern of per-project opt-in settings.
- **Automatic background sweep**, not manual-only — matching this
  app's existing background-loop precedent (online scoring, alert
  notifications, the three Phase 3 incident passes), just on a much
  slower cadence (once per 24h, not every 60s — archival is cheap to
  run rarely).
- **No archive-browsing UI for v1** — the archive table is a durable
  historical record, not something the app reads back. Nothing here
  builds a restore path or a "view archived traces" endpoint.

## The integrity gap this design closes

A research pass before this design was written (verifying every real FK
and every "soft" reference to a `Trace`/`TraceFlag` row, not guessing)
found: `IncidentSignal.source_id` (when `source_type='trace_flag'`) is a
**plain UUID column with no FK constraint** — it's a polymorphic
reference that also points at `AlertRule`/`SessionHalt` rows depending on
`source_type`. The one place that dereferences it,
`_incident_signal_cleared` (main.py, used by the automation auto-resolve
pass), already treats a missing `TraceFlag` as "cleared":

```python
if signal.source_type == "trace_flag":
    flag = db.get(TraceFlag, signal.source_id)
    return flag is None or flag.resolved_at is not None
```

If a `Trace` with an **open** (unresolved) `TraceFlag` were archived and
deleted, the cascade would delete that `TraceFlag` too, and any incident
whose `IncidentSignal` referenced it would then read as "cleared" —
auto-resolving with the note "Auto-resolved: every underlying signal
cleared" in automation-enabled projects, even though nothing was actually
resolved; the evidence was just deleted out from under it. Excluding a
trace with any open flag from archival (see below) closes this
entirely: by the time a trace is eligible for deletion, every
`TraceFlag` on it is already resolved, so `_incident_signal_cleared`'s
"missing = cleared" fallback and "resolved_at is not None = cleared"
branch agree — there's no state a deletion could have misrepresented.

## Data model

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_days INTEGER;
-- NULL means "keep forever" (no retention enforced), matching the
-- existing max_session_steps/max_session_cost/max_session_seconds
-- "NULL means no limit" convention on this same table.

CREATE TABLE IF NOT EXISTS archived_traces (
    id UUID PRIMARY KEY,  -- the ORIGINAL trace's id, not a new one
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    original_started_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archived_traces_project ON archived_traces(project_id, original_started_at);
```

`data`'s shape: the trace's own columns (name, input, output, model,
session_id, agent_id, total_tokens, cost, started_at, ended_at,
review_note) plus three nested arrays — `spans` (every span's own
columns), `scores` (every score's own columns), and `trace_flags` (every
flag's own columns — all guaranteed resolved, per the eligibility rule
below). This is a full-fidelity snapshot, not a summary — nothing about
the original trace is lossy, it's just collapsed from several normalized
rows into one row per trace.

## Eligibility rule

A trace is eligible for archival when **all** of:

1. `retention_days` is set on its project, and `started_at` is older
   than `now() - retention_days days`.
2. `ended_at IS NOT NULL` — a still-in-progress ("pending") trace is
   never archived regardless of how old `started_at` is; only completed
   traces are considered "old" in a meaningful sense.
3. It has **no `trace_flags` row with `resolved_at IS NULL`** — closes
   the integrity gap above, and as a direct side effect also means a
   trace still sitting in the human Review Queue is never silently
   removed out from under whoever's working it.

**Known consequence, accepted deliberately:** flags are only ever
resolved by a human (`PATCH /traces/{id}/flag` or
`.../flags/{flag_id}`) — the `anomaly` and `guardrail` sources that
auto-create a flag never auto-resolve it. So a trace that ever tripped
an anomaly heuristic or a guardrail check is retained **indefinitely**,
regardless of `retention_days`, until someone clears it in the Review
Queue. In a project with a steady anomaly/guardrail rate and an
unattended Review Queue, this set of permanently-exempt traces grows
without bound — this is the direct cost of rule 3's safety guarantee,
not an oversight, but it does mean `retention_days` alone doesn't
guarantee a bounded working set. There's currently no count or metric
surfacing how many traces are being held back this way; that would be a
reasonable follow-up if this proves to matter in practice.

## Archival mechanism

One DB transaction per eligible trace (not one big transaction for the
whole batch — a failure on trace N must not roll back traces 1..N-1
that already archived cleanly):

1. Load the trace with its spans/scores/trace_flags (all already
   guaranteed resolved per the eligibility rule).
2. Build the JSONB snapshot described above.
3. Insert one `archived_traces` row.
4. Delete the `Trace` row — existing `ON DELETE CASCADE`s on
   `spans.trace_id`/`scores.trace_id`/`trace_flags.trace_id` handle the
   rest; `experiment_results.trace_id` is already `ON DELETE SET NULL`,
   so a trace that was saved into a past Experiment survives as a
   nulled-out reference in that experiment's results, not a cascade
   failure.
5. Commit.

Each trace's insert-then-delete is wrapped in its own try/except (same
per-item error-isolation precedent as every other background-loop pass
in this app) so one bad trace can't abort the rest of the sweep's batch.

## Trigger: a new background loop

`_retention_sweep_loop`, registered in `lifespan` alongside the existing
loops, but on a 24-hour interval (`_RETENTION_SWEEP_INTERVAL_SECONDS =
86400`) rather than 60 seconds — archival doesn't need near-real-time
responsiveness, and running it rarely keeps it cheap. Each tick:

1. Query every `Project` with `retention_days IS NOT NULL`.
2. For each, query its eligible traces (the rule above), capped at
   `_RETENTION_SWEEP_BATCH_SIZE = 200` per project per tick — the same
   "bound the work per tick" precedent as
   `_ONLINE_SCORING_BATCH_SIZE`/`_INCIDENT_RECOVERY_BATCH_SIZE`. A
   project with a larger backlog than the cap simply continues
   shrinking it over subsequent ticks rather than doing unbounded work
   in one pass.
3. Archive each eligible trace per the mechanism above.

Gets `record_loop_tick("retention_sweep", duration)` from the
already-shipped Prometheus work, for free — this loop's health is
visible on `/metrics` the same way every other loop's is, with zero
extra design needed. One caveat worth stating explicitly: every other
instrumented loop ticks every 60 seconds, so
`background_loop_last_run_timestamp_seconds{loop_name="retention_sweep"}`
will legitimately be up to 24 hours stale at any given moment. A
monitoring rule written against this metric with a generic "loop hasn't
ticked in N minutes" threshold will permanently false-positive on this
one label — any alert built on this metric needs a `retention_sweep`-
specific threshold, not the same one used for the 60s-cadence loops.

## Project Settings UI

A new "Data Retention" card, same shape and admin-gating as the existing
Kill-Switch Limits card: one number input (days; blank = keep forever),
a Save button. Copy states plainly that traces older than the window
get archived and removed from the dashboards that read live trace data
(Overview, Performance, Cost & Usage) — not a bug, the intended effect,
but something a project admin should knowingly opt into rather than
discover later as a surprise.

## Explicitly out of scope for this turn

- Archive browsing/restore (any `GET /archived-traces` endpoint or UI
  page) — confirmed with the user; the archive is a durable record, not
  something the app reads back in v1.
- External object storage — same reasoning as the destination decision
  above.
- Retroactively archiving anything on `retention_days` being set for
  the first time is NOT special-cased — the very next sweep tick (within
  24h) picks up anything already past the window, exactly like turning
  the setting on at any other time.
- Any change to how Overview/Performance/Cost & Usage/Traces query
  data — they already read live traces only; archived traces simply stop
  appearing there, which is the intended effect, not a new code path.

## Testing plan

New `tests/test_retention.py`, same live-server convention as every
other suite:

- A trace with `ended_at` set, backdated `started_at`, and
  `retention_days` set low enough to be already-eligible gets archived
  and deleted within one sweep tick (poll `GET /traces/{id}` for 404,
  and directly query — via a small test-only DB helper matching this
  repo's existing `print_span_from_db`-style direct-connection pattern
  in `test_error_explanation.py` — that an `archived_traces` row now
  exists with the right `project_id`/`data` contents).
- A trace with an **unresolved** `trace_flag` is NOT archived even past
  its retention window — proves the eligibility rule's safety check.
- A still-`pending` trace (`ended_at IS NULL`) past its retention window
  is NOT archived.
- A project with `retention_days IS NULL` (the default) never has any
  trace archived regardless of age.
- The batch cap itself (`_RETENTION_SWEEP_BATCH_SIZE = 200`) is verified
  by code inspection during task review (the `.limit(...)` call is
  present and uses the named constant), not by a dedicated test that
  seeds 200+ traces — the same verification approach already used for
  the existing `_ONLINE_SCORING_BATCH_SIZE`/`_INCIDENT_RECOVERY_BATCH_SIZE`
  caps, since a fixture that large adds real test runtime for a
  boundary that isn't behaviorally interesting beyond "the number is
  actually applied."
- `record_loop_tick("retention_sweep", ...)` is called from
  `_retention_sweep_loop`, ties the new loop into the Prometheus work
  already shipped — verified by code inspection during task review, NOT
  by a live poll of `GET /metrics` the way the other four loops' tests
  do. Those loops tick every 60 seconds, so a test can wait for a real
  tick within a reasonable timeout; this one ticks once per 24 hours,
  which no test should ever wait for. This is a deliberate, narrower
  verification method for this one loop, not an oversight.
