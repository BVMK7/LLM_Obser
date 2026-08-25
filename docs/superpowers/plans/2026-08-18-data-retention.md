# Data Retention & Archival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Traces older than a per-project `retention_days` window get archived (a full JSONB snapshot) and then deleted from the live tables, via a new 24-hour background sweep — with a safety rule that never touches a trace that still has an unresolved review-queue flag.

**Architecture:** A new `archived_traces` table (one JSONB-snapshot row per archived trace) plus `Project.retention_days` (NULL = keep forever). A new background loop, same shape as the existing ones, ticks once per 24h and archives-then-deletes eligible traces per project. A new Project Settings card exposes the setting.

**Tech Stack:** FastAPI, SQLAlchemy (Postgres), Pydantic, pytest against a live server (this repo's only testing convention — see `tests/conftest.py`). React/Vite frontend for the one settings card.

**Spec:** `docs/superpowers/specs/2026-08-18-data-retention-design.md`

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-18-data-retention-design.md`. Every task below implements one section of it.
- **Eligibility rule** (binding, do not loosen): a trace is only archived if `ended_at IS NOT NULL` AND it has zero `trace_flags` rows with `resolved_at IS NULL`. This is what prevents the `IncidentSignal.source_id` soft-reference integrity gap described in the spec, and also keeps anything still in the human Review Queue from disappearing.
- `retention_days` is per-project, NULL means "keep forever" — same convention as `max_session_steps`/`max_session_cost`/`max_session_seconds` already on `Project`.
- Archive destination is the SAME Postgres database — a new `archived_traces` table with a JSONB blob, not external storage.
- No archive-browsing endpoint or UI in this plan — confirmed out of scope.
- This repo's only testing convention is live-server integration tests over real HTTP (no mocks, no in-process TestClient) — see `tests/conftest.py`'s docstring. The one deliberate exception: because the real sweep loop only ticks once per 24h, tests import `_run_retention_sweep_once`/`SessionLocal` directly from `main` and call it synchronously to force one sweep, instead of waiting a day — the same class of "reach past pure HTTP for verification" already established by this repo's `test_error_explanation.py`, which queries Postgres directly via `create_engine(DATABASE_URL)`. Do not modify `tests/conftest.py`.
- Migrations are plain root-level `.sql` files, idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), applied via `.github/workflows/eval.yml`'s hardcoded ordered list — the last entry today is `add_phase3_incidents.sql`.

---

### Task 1: Migration

**Files:**
- Create: `add_data_retention.sql`
- Modify: `.github/workflows/eval.yml` (migration list, ~line 76)

**Interfaces:**
- Produces: `projects.retention_days` column, `archived_traces` table — Task 2's models map onto these exact names/types.

- [ ] **Step 1: Write the migration file**

```sql
-- add_data_retention.sql
-- Data retention & archival. See
-- docs/superpowers/specs/2026-08-18-data-retention-design.md.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_days INTEGER;

CREATE TABLE IF NOT EXISTS archived_traces (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    original_started_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archived_traces_project ON archived_traces(project_id, original_started_at);
```

- [ ] **Step 2: Apply it to the local dev Postgres**

Run: `docker exec -i llm-observability-db psql -U postgres -d llm_observability -f - < add_data_retention.sql` (check `docker ps` first for the actual container/db name if this doesn't match).

Expected: `ALTER TABLE`/`CREATE TABLE`/`CREATE INDEX` output, no errors. Re-running the same command a second time must also succeed with no errors (idempotency check).

- [ ] **Step 3: Add it to the CI migration list**

In `.github/workflows/eval.yml`, find the line ending `add_agentops_phase1.sql add_phase2_operational.sql add_phase3_incidents.sql; do` and change it to:

```
                   add_agentops_phase1.sql add_phase2_operational.sql add_phase3_incidents.sql add_data_retention.sql; do
```

- [ ] **Step 4: Commit**

```bash
git add add_data_retention.sql .github/workflows/eval.yml
git commit -m "Add data retention migration (projects.retention_days, archived_traces)"
```

---

### Task 2: Models, schemas, snapshot-building, and the archival function

**Files:**
- Modify: `main.py` — new `ArchivedTrace` model, `Project.retention_days` column, `ProjectResponse`/`ProjectUpdate` fields, new `_build_trace_archive_snapshot`/`_archive_trace` functions.

**Interfaces:**
- Consumes: `Trace`, `TraceFlag`, `TraceWithSpans`, `SpanResponse`, `ScoreResponse`, `TraceFlagResponse` (all existing).
- Produces: `ArchivedTrace` (SQLAlchemy model); `_archive_trace(db: Session, trace: "Trace") -> None` — Task 3's sweep function calls this by exact name/signature.

- [ ] **Step 1: Add the `ArchivedTrace` model**

Insert directly after the existing `TraceFlag` class (main.py, right before the `Span` class comment block):

```python
# One row per archived trace — see _archive_trace below. `id` is the
# ORIGINAL trace's id (not server-generated), so an archived trace keeps
# the same identity it always had. `data` is a full-fidelity JSONB
# snapshot (trace + its spans + scores + trace_flags), not a summary —
# nothing about the original is lossy, it's just collapsed from several
# normalized rows into one. No browsing endpoint reads this table in this
# version — it exists purely as a durable historical record.
class ArchivedTrace(Base):
    __tablename__ = "archived_traces"

    id = Column(UUID(as_uuid=True), primary_key=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    original_started_at = Column(DateTime(timezone=True), nullable=False)
    archived_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    data = Column(JSONB, nullable=False)
```

- [ ] **Step 2: Add the `Project.retention_days` column**

In the existing `Project` class, right after `incident_automation_enabled = Column(Boolean, nullable=False, server_default="false")`:

```python
    # Data retention (see ArchivedTrace) — NULL means "keep forever," same
    # convention as max_session_steps/max_session_cost/max_session_seconds
    # above. A background sweep archives-then-deletes traces older than
    # this many days, once they have no unresolved trace_flags.
    retention_days = Column(Integer)
```

- [ ] **Step 3: Add `ProjectResponse`/`ProjectUpdate` fields**

In `ProjectResponse` (main.py, currently ending with `incident_automation_enabled: bool = False` before `model_config = ConfigDict(from_attributes=True)`), add:

```python
    retention_days: Optional[int] = None
```

In `ProjectUpdate` (main.py, currently ending with `incident_automation_enabled: Optional[bool] = None`), add:

```python
    retention_days: Optional[int] = None
```

(`update_project` needs no code change — it already applies `body.model_dump(exclude_unset=True)` generically via `setattr`.)

- [ ] **Step 4: Add the snapshot-building and archival functions**

Place these near `_create_trace_flag`/`_sync_trace_flag_summary` (main.py) — anywhere after `TraceWithSpans`/`TraceFlagResponse` are defined, since both are used here:

```python
# Builds the full-fidelity JSONB snapshot for one trace: its own fields
# plus nested spans/scores (via the existing TraceWithSpans schema, which
# already bundles all three) plus trace_flags (queried separately, same
# as every other trace_flags read in this app — Trace has no ORM
# relationship to TraceFlag). mode="json" makes Pydantic serialize
# datetimes/UUIDs/Decimals into plain JSON-safe values instead of Python
# objects a JSONB column can't store directly.
def _build_trace_archive_snapshot(db: Session, trace: "Trace") -> dict:
    trace.status = "error" if any(span.error for span in trace.spans) else "success"
    snapshot = TraceWithSpans.model_validate(trace).model_dump(mode="json")
    flags = db.query(TraceFlag).filter(TraceFlag.trace_id == trace.id).order_by(TraceFlag.created_at.asc()).all()
    snapshot["trace_flags"] = [TraceFlagResponse.model_validate(f).model_dump(mode="json") for f in flags]
    return snapshot


# Archives then deletes ONE trace, in a single transaction — the caller
# (the sweep in Task 3) is responsible for having already confirmed
# eligibility (ended, no open trace_flags); this function just does the
# work. db.delete(trace) relies on the existing ON DELETE CASCADE on
# spans.trace_id/scores.trace_id/trace_flags.trace_id (Postgres-level,
# not an ORM-level cascade) to remove the trace's children.
def _archive_trace(db: Session, trace: "Trace") -> None:
    snapshot = _build_trace_archive_snapshot(db, trace)
    db.add(ArchivedTrace(
        id=trace.id, project_id=trace.project_id,
        original_started_at=trace.started_at, data=snapshot,
    ))
    db.delete(trace)
    db.commit()
```

- [ ] **Step 5: Verify it imports cleanly**

Run: `python -m py_compile main.py && python -c "import main; print(main.ArchivedTrace, main._archive_trace)"`
Expected: prints the class/function references, no traceback.

- [ ] **Step 6: Commit**

```bash
git add main.py
git commit -m "Add ArchivedTrace model, retention_days field, and the archival function"
```

---

### Task 3: Background sweep loop

**Files:**
- Modify: `main.py` — new `_run_retention_sweep_once`/`_retention_sweep_loop` functions, wired into `lifespan`.

**Interfaces:**
- Consumes: `_archive_trace` (Task 2), `record_loop_tick` from `metrics.py` (already imported into `main.py` from the Prometheus work).
- Produces: nothing new consumed by later tasks — Task 4's tests call `_run_retention_sweep_once` directly.

- [ ] **Step 1: Add the sweep function**

Place near `_run_incident_recovery_once`/`_run_incident_automation_once` (main.py), which this mirrors closely:

```python
# Bounds work per project per tick — same precedent as
# _ONLINE_SCORING_BATCH_SIZE/_INCIDENT_RECOVERY_BATCH_SIZE. A project with
# a bigger backlog than this just keeps shrinking it over later ticks.
_RETENTION_SWEEP_BATCH_SIZE = 200


def _run_retention_sweep_once(db: Session) -> None:
    projects = db.query(Project).filter(Project.retention_days.isnot(None)).all()
    for project in projects:
        cutoff = datetime.now(timezone.utc) - timedelta(days=project.retention_days)
        # Same "trace_ids_with_open_flags" subquery idiom GET /traces/flagged
        # already uses — traces with at least one unresolved flag are the
        # ones this sweep must never touch (see the design spec's
        # eligibility rule and the IncidentSignal integrity gap it closes).
        trace_ids_with_open_flags = (
            db.query(TraceFlag.trace_id).filter(TraceFlag.resolved_at.is_(None)).distinct().subquery()
        )
        eligible = (
            db.query(Trace)
            .filter(
                Trace.project_id == project.id,
                Trace.ended_at.isnot(None),
                Trace.started_at < cutoff,
                ~Trace.id.in_(db.query(trace_ids_with_open_flags)),
            )
            .limit(_RETENTION_SWEEP_BATCH_SIZE)
            .all()
        )
        # Captured up front, before any per-trace commit() below can expire
        # these ORM objects (SQLAlchemy's default expire_on_commit=True) —
        # same fix already applied to the incident background passes: an
        # exception's own logging line re-reading an expired instance's
        # attributes would otherwise itself raise and escape uncaught.
        trace_ids = [trace.id for trace in eligible]
        for trace, trace_id in zip(eligible, trace_ids):
            try:
                _archive_trace(db, trace)
            except Exception as e:
                db.rollback()
                print(f"[retention-sweep] failed archiving trace {trace_id}: {e}")


_RETENTION_SWEEP_INTERVAL_SECONDS = 86400  # 24h — archival doesn't need near-real-time responsiveness


async def _retention_sweep_loop():
    while True:
        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_retention_sweep_once, db)
        except Exception as e:
            print(f"[retention-sweep] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("retention_sweep", time.perf_counter() - tick_start)
        await asyncio.sleep(_RETENTION_SWEEP_INTERVAL_SECONDS)
```

- [ ] **Step 2: Wire it into `lifespan`**

Change (main.py):

```python
    background_tasks = [
        asyncio.create_task(_online_scoring_loop()),
        asyncio.create_task(_alert_notification_loop()),
    ]
```

to:

```python
    background_tasks = [
        asyncio.create_task(_online_scoring_loop()),
        asyncio.create_task(_alert_notification_loop()),
        asyncio.create_task(_retention_sweep_loop()),
    ]
```

- [ ] **Step 3: Verify it imports cleanly and the server starts**

Run: `python -m py_compile main.py && python -c "import main"` — no traceback.

Kill anything on port 8010, then start `python -m uvicorn main:app --port 8010` (not `--reload`). Confirm `GET /docs` returns 200 and the startup log shows no traceback (the new loop starting is silent by design, matching the other two — nothing prints on a clean start).

- [ ] **Step 4: Confirm the Prometheus tie-in by direct inspection (not a live poll)**

Unlike the other four named loops (60s cadence — a test can wait for a real tick), this one ticks once per 24h, which no test should ever wait for. Instead, just re-read the `_retention_sweep_loop` function you wrote in Step 1 and confirm `record_loop_tick("retention_sweep", time.perf_counter() - tick_start)` is present in its `finally` block, at the same position as the equivalent line in `_online_scoring_loop`. Note this explicitly in your task report — the task reviewer will check the same thing from the diff rather than expect a `test_metrics.py` addition for this loop.

- [ ] **Step 5: Commit**

```bash
git add main.py
git commit -m "Add retention sweep background loop"
```

---

### Task 4: Project Settings UI

**Files:**
- Modify: `frontend/src/pages/ProjectSettings.jsx`

**Interfaces:**
- Consumes: `updateProject` (existing, from `../api`), `retention_days` field on the project object returned by `getProjects()` (already flows through automatically once Task 2's `ProjectResponse` change is live).

- [ ] **Step 1: Add the draft helper**

Directly after the existing `incidentDraftFrom` function in `ProjectSettings.jsx`:

```jsx
function retentionDraftFrom(project) {
  return {
    retention_days: project.retention_days ?? "",
  };
}
```

- [ ] **Step 2: Add state hooks**

Directly after the existing `incidentSaved` state hook:

```jsx
  const [retentionDraft, setRetentionDraft] = useState(retentionDraftFrom({}));
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionSaved, setRetentionSaved] = useState(false);
```

- [ ] **Step 3: Populate the draft on load**

In `loadAll`, directly after the existing `setIncidentDraft(incidentDraftFrom(project));` line:

```jsx
        setRetentionDraft(retentionDraftFrom(project));
```

- [ ] **Step 4: Add the save handler**

Directly after the existing `handleIncidentSave` function:

```jsx
  // retention_days only ever controls the background archival sweep —
  // never anything about what an agent is allowed to do, same
  // "bookkeeping only" precedent as incident automation above.
  const handleRetentionSave = (e) => {
    e.preventDefault();
    setRetentionSaving(true);
    setRetentionSaved(false);
    setError(null);
    const toNumberOrNull = (v) => (v === "" ? null : Number(v));
    updateProject(id, {
      name: projectName,
      retention_days: toNumberOrNull(retentionDraft.retention_days),
    })
      .then(() => setRetentionSaved(true))
      .catch((err) => setError(err.message))
      .finally(() => setRetentionSaving(false));
  };
```

- [ ] **Step 5: Add the settings card**

Directly before the existing `{/* Billing */}` comment/card:

```jsx
        {/* Data Retention */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-4">
          <div className="text-sm font-medium text-[var(--text-primary)] mb-1">Data Retention</div>
          <p className="text-xs text-[var(--text-muted)] mb-3">
            Traces older than this get archived and removed — they'll stop showing up in Overview, Performance, and
            Cost & Usage. Leave blank to keep everything forever.
          </p>
          {!isAdmin ? (
            <div className="text-xs text-[var(--text-muted)]">Only admins can view or change data retention.</div>
          ) : (
            <form onSubmit={handleRetentionSave} className="flex flex-col gap-2">
              <label className="block text-xs text-[var(--text-muted)]">Keep traces for (days)</label>
              <input
                type="number"
                min="1"
                placeholder="Forever"
                value={retentionDraft.retention_days}
                onChange={(e) => setRetentionDraft((d) => ({ ...d, retention_days: e.target.value }))}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
              />
              <button
                type="submit"
                disabled={retentionSaving}
                className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50 mt-1"
              >
                {retentionSaving ? "Saving..." : retentionSaved ? "Saved" : "Save Retention"}
              </button>
            </form>
          )}
        </div>
```

- [ ] **Step 6: Manual smoke test**

Point `frontend/.env`'s `VITE_API_BASE` at `http://localhost:8010` (the local backend from Task 3), restart the Vite dev server, log in, navigate to a project's Settings page, confirm the "Data Retention" card renders with the same visual shape as Kill-Switch Limits/Incident Settings, enter a number, save, reload the page, and confirm the value persisted. Restore `VITE_API_BASE` to the Render URL afterward.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/ProjectSettings.jsx
git commit -m "Add Data Retention card to Project Settings"
```

---

### Task 5: Test suite

**Files:**
- Create: `tests/test_retention.py`

**Interfaces:**
- Consumes: `admin_headers`, `project`, `api_headers` fixtures (existing, `tests/conftest.py`); `SessionLocal`, `_run_retention_sweep_once` imported directly from `main` (see Global Constraints for why).

**Note on approach:** unlike every other background loop in this app (60s cadence, testable by polling), this one ticks once per 24h — polling for a real tick isn't practical in a test. Tests instead import `_run_retention_sweep_once` and call it directly against a fresh `SessionLocal()`, forcing one synchronous sweep. This is a deliberate exception to "live-server HTTP only," in the same spirit as `test_error_explanation.py`'s existing direct-Postgres-connection pattern — there's no HTTP endpoint for "run a sweep right now" by design (out of scope per the spec), so direct invocation is the only way to test the sweep's behavior without an unreasonably slow test.

- [ ] **Step 1: Write the test file**

```python
"""
Integration tests for data retention & archival. Traces/settings go
through the real API; the sweep itself (which only ticks once per 24h in
the running server) is invoked directly rather than waited for — see the
plan's Task 5 note for why this is a deliberate, narrow exception to this
repo's live-server-HTTP-only testing convention.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import requests
from sqlalchemy import text

from main import SessionLocal, _run_retention_sweep_once

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _iso(dt):
    return dt.isoformat()


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _patch(path, headers, body=None):
    return requests.patch(f"{BACKEND_URL}{path}", headers=headers, json=body or {})


def _get(path, headers):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers)
    resp.raise_for_status()
    return resp.json()


def _set_retention(admin_headers, project_id, days):
    requests.patch(
        f"{BACKEND_URL}/projects/{project_id}", headers=admin_headers,
        json={"name": "retention-test", "retention_days": days},
    ).raise_for_status()


def _archived_row(trace_id):
    db = SessionLocal()
    try:
        return db.execute(
            text("SELECT project_id, data FROM archived_traces WHERE id = :id"),
            {"id": str(trace_id)},
        ).fetchone()
    finally:
        db.close()


def test_old_completed_trace_gets_archived_and_deleted(admin_headers, project, api_headers):
    _set_retention(admin_headers, project["id"], 1)

    old_started = datetime.now(timezone.utc) - timedelta(days=5)
    trace = _post("/traces", api_headers, {"name": "old_trace", "started_at": _iso(old_started)})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    missing = requests.get(f"{BACKEND_URL}/traces/{trace['id']}", headers=api_headers)
    assert missing.status_code == 404

    row = _archived_row(trace["id"])
    assert row is not None
    assert str(row.project_id) == project["id"]
    assert row.data["name"] == "old_trace"


def test_trace_with_open_flag_is_not_archived(admin_headers, project, api_headers):
    _set_retention(admin_headers, project["id"], 1)

    old_started = datetime.now(timezone.utc) - timedelta(days=5)
    trace = _post("/traces", api_headers, {"name": "flagged_old_trace", "started_at": _iso(old_started)})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})
    _patch(f"/traces/{trace['id']}/flag", api_headers, {"flagged_for_review": True, "review_note": "still needs a look"})

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    still_there = _get(f"/traces/{trace['id']}", api_headers)
    assert still_there["id"] == trace["id"]
    assert _archived_row(trace["id"]) is None


def test_pending_trace_is_not_archived(admin_headers, project, api_headers):
    _set_retention(admin_headers, project["id"], 1)

    old_started = datetime.now(timezone.utc) - timedelta(days=5)
    trace = _post("/traces", api_headers, {"name": "pending_old_trace", "started_at": _iso(old_started)})
    # Deliberately never PATCHed with ended_at — stays "pending".

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    still_there = _get(f"/traces/{trace['id']}", api_headers)
    assert still_there["id"] == trace["id"]
    assert _archived_row(trace["id"]) is None


def test_no_retention_set_never_archives(admin_headers, project, api_headers):
    # project fixture's default has retention_days unset (NULL).
    old_started = datetime.now(timezone.utc) - timedelta(days=365)
    trace = _post("/traces", api_headers, {"name": "ancient_trace", "started_at": _iso(old_started)})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    still_there = _get(f"/traces/{trace['id']}", api_headers)
    assert still_there["id"] == trace["id"]
    assert _archived_row(trace["id"]) is None
```

- [ ] **Step 2: Run the new tests in isolation**

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/test_retention.py -v`
Expected: some failures on the first run are normal — fix in place per the next step, don't move on with red tests.

- [ ] **Step 3: Fix any failures**

Common ones to check first: a 404 on `PATCH /traces/{id}/flag` or `/projects/{id}` (compare against Task 2/3's exact field names); `_archived_row` returning `None` when it shouldn't (check the eligibility filter in `_run_retention_sweep_once` matches the plan exactly — in particular, double-check timezone-aware datetime comparison between `Trace.started_at` and `cutoff`). Iterate until every test in this file passes.

- [ ] **Step 4: Run the full suite to check for regressions**

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/ -v`
Expected: all pre-existing tests (Phase 1/2/3, Prometheus metrics) still pass, plus the 4 new retention tests. This takes ~9-10 minutes (one pre-existing test polls a real 60s loop) — let it run to completion.

- [ ] **Step 5: Commit**

```bash
git add tests/test_retention.py
git commit -m "Add data retention test suite"
```

---

### Task 6: Final regression pass

**Files:** none (verification only).

- [ ] **Step 1: Full clean-restart regression run**

Restart the local backend fresh (kill any zombie process on port 8010 first), confirm the migration from Task 1 is applied, then:

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/ -v`
Expected: 100% pass — proves Task 2/3's additions (new model, new loop registered in `lifespan`) didn't regress anything already covered.

- [ ] **Step 2: `git status` sanity check**

Run: `git status --short`
Expected: clean — nothing left uncommitted from Tasks 1-5.

- [ ] **Step 3: Report completion**

Summarize what shipped (per-project retention window, archive-then-delete via a 24h background sweep, the trace_flags safety rule, the Project Settings card) and that nothing has been pushed/deployed yet — matching this project's established pattern of an explicit push/deploy confirmation step before touching `origin/main` or Render.
