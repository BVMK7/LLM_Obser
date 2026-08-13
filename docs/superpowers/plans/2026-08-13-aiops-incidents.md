# AgentOps Phase 3 (AIOps Incidents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correlate the three existing signal sources (`AlertRule` triggers, `trace_flags`, kill-switch `SessionHalt`s) into project+category-scoped `incidents`, with fingerprint-deduped signal logging, an explicit open→acknowledged→resolved state machine, LLM-generated structured recovery guidance, and an opt-in bookkeeping-only automation toggle.

**Architecture:** Two new tables (`incidents`, `incident_signals`) plus two new columns on `projects` and one on `alert_rules`. Signal attachment happens synchronously at the three existing write paths that already create trace_flags/halts (no new poller for those), reusing the exact `_get_or_create_agent`-style "insert, catch IntegrityError, treat as no-op" race handling. Alert-rule correlation, recovery-guidance generation, and automation auto-resolve all piggyback on the *existing* `_alert_notification_loop`'s 60s tick as two new passes, rather than adding new background loops.

**Tech Stack:** FastAPI, SQLAlchemy (Postgres), Pydantic, Groq (via the existing `PROVIDERS["groq"]` client), pytest against a live server (this repo's only testing convention — see `tests/conftest.py`).

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-13-aiops-incidents-design.md`. Every task below implements one section of it; deviations are called out inline with why.
- This codebase's existing convention (confirmed across Phase 1 and Phase 2, both already shipped) is **one comprehensive live-server pytest file per phase**, written and run once the full vertical slice (models + hooks + endpoints) exists — not per-function unit tests, since this app has none anywhere and the DB/HTTP-integration style is deliberate (see `tests/conftest.py`'s docstring). This plan follows that convention: Task 6 is where the test file is written and iterated on, matching exactly how `tests/test_phase2_operational.py` was actually built.
- Migrations are plain root-level `.sql` files, idempotent (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), applied via `.github/workflows/eval.yml`'s hardcoded ordered list.
- `SessionLocal` is `autocommit=False, autoflush=False` — any code that mutates an ORM object and immediately queries for it in the same session needs an explicit `db.flush()` first (this has bitten this codebase twice already; see `_sync_trace_flag_summary`).
- Never regenerate this repo's LICENSE/README; never touch frontend or SDK code in this plan — both are explicitly out of scope per the spec (deferred to a follow-up turn).

---

### Task 1: Migration

**Files:**
- Create: `add_phase3_incidents.sql`
- Modify: `.github/workflows/eval.yml` (migration list, ~line 76)

**Interfaces:**
- Produces: tables `incidents`, `incident_signals`; columns `projects.incident_webhook_url`, `projects.incident_automation_enabled`, `alert_rules.last_incident_signal_at` — everything downstream (Task 2's models) maps onto these exact names/types.

- [ ] **Step 1: Write the migration file**

```sql
-- add_phase3_incidents.sql
-- AgentOps Phase 3: correlates AlertRule triggers, trace_flags, and
-- kill-switch SessionHalts into project+category-scoped incidents. See
-- docs/superpowers/specs/2026-08-13-aiops-incidents-design.md.

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('cost', 'reliability', 'performance', 'safety')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolved_note TEXT,
    recovery_suggestion TEXT,
    recovery_suggestion_json JSONB,
    recovery_generated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_open_lookup ON incidents(project_id, category, status) WHERE status != 'resolved';

CREATE TABLE IF NOT EXISTS incident_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('alert_rule', 'trace_flag', 'kill_switch')),
    source_id UUID NOT NULL,
    reason TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_signals_fingerprint ON incident_signals(fingerprint);
CREATE INDEX IF NOT EXISTS idx_incident_signals_incident_id ON incident_signals(incident_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS incident_webhook_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS incident_automation_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS last_incident_signal_at TIMESTAMPTZ;
```

- [ ] **Step 2: Apply it to the local dev Postgres**

Run: `docker exec -i llm-observability-db psql -U postgres -d llm_observability -f -  < add_phase3_incidents.sql` (adjust container/db name to match whatever's already running locally — check with `docker ps` first if unsure).

Expected: `CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE` output for every statement, no errors. Re-running the same command a second time must also succeed with no errors (idempotency check).

- [ ] **Step 3: Add it to the CI migration list**

In `.github/workflows/eval.yml`, find the line ending `add_agentops_phase1.sql add_phase2_operational.sql; do` and change it to:

```
                   add_agentops_phase1.sql add_phase2_operational.sql add_phase3_incidents.sql; do
```

- [ ] **Step 4: Commit**

```bash
git add add_phase3_incidents.sql .github/workflows/eval.yml
git commit -m "Add Phase 3 incidents migration (incidents, incident_signals, project/alert_rule columns)"
```

---

### Task 2: Models & schemas

**Files:**
- Modify: `main.py` — add SQLAlchemy models near `TraceFlag`/`AlertRule`/`PolicyRule`; add Pydantic schemas near the policy-engine section (~line 2790, right before the `# Continuous (online) scoring` comment block).

**Interfaces:**
- Consumes: `Base` (declarative base already defined at top of `main.py`), existing `Project`/`AlertRule`/`TraceFlag` models.
- Produces: SQLAlchemy classes `Incident`, `IncidentSignal` (used by every later task); Pydantic `IncidentSignalResponse`, `IncidentResponse`, `IncidentUpdate` (used by Task 5's endpoints).

- [ ] **Step 1: Add the two SQLAlchemy models**

Insert directly after the existing `PolicyRule` class (main.py, right after its closing line, before the `SessionHalt` class comment block):

```python
# ---------------------------------------------------------------------------
# AgentOps Phase 3 — correlates AlertRule triggers, trace_flags, and
# kill-switch SessionHalts into one incident per (project, category) at a
# time, instead of three disconnected systems. See _attach_incident_signal
# below for the correlation logic, and docs/superpowers/specs/
# 2026-08-13-aiops-incidents-design.md for the full design.
# ---------------------------------------------------------------------------
class Incident(Base):
    __tablename__ = "incidents"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    category = Column(String, nullable=False)   # "cost" | "reliability" | "performance" | "safety"
    status = Column(String, nullable=False, server_default="open")  # "open" | "acknowledged" | "resolved"
    severity = Column(String, nullable=False, server_default="medium")  # "low" | "medium" | "high"
    opened_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    acknowledged_at = Column(DateTime(timezone=True))
    resolved_at = Column(DateTime(timezone=True))
    resolved_note = Column(Text)
    # LLM-generated advisory guidance — recovery_suggestion is a prose
    # rendering, recovery_suggestion_json the structured form a UI can
    # render as a checklist. Both NULL until the background loop's recovery
    # pass first runs for this incident (see _run_incident_recovery_once).
    recovery_suggestion = Column(Text)
    recovery_suggestion_json = Column(JSONB)
    recovery_generated_at = Column(DateTime(timezone=True))


class IncidentSignal(Base):
    __tablename__ = "incident_signals"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    incident_id = Column(UUID(as_uuid=True), ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False)
    source_type = Column(String, nullable=False)  # "alert_rule" | "trace_flag" | "kill_switch"
    source_id = Column(UUID(as_uuid=True), nullable=False)
    reason = Column(Text, nullable=False)
    # Unique per signal event — see _incident_signal_fingerprint. Prevents
    # a race (two overlapping loop ticks, a retried request) from double-
    # inserting the same signal; caught as IntegrityError, same pattern
    # _get_or_create_agent already uses for exactly this kind of race.
    fingerprint = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
```

- [ ] **Step 2: Add the two new `Project` columns**

In the existing `Project` class, right after `kill_switch_webhook_url = Column(Text)`:

```python
    # Phase 3 incidents — see Incident/IncidentSignal above.
    # incident_webhook_url: notified once when a NEW incident opens (not on
    # every signal attach, and not on auto-resolve). incident_automation_
    # enabled: when true, incidents auto-acknowledge on open and auto-
    # resolve once every attached signal individually clears — bookkeeping
    # only, never anything that changes what an agent is allowed to do.
    incident_webhook_url = Column(Text)
    incident_automation_enabled = Column(Boolean, nullable=False, server_default="false")
```

- [ ] **Step 3: Add the new `AlertRule` column**

In the existing `AlertRule` class, right after `last_notified_at = Column(DateTime(timezone=True))`:

```python
    # Separate cooldown from last_notified_at above — a rule with no
    # webhook_url still needs incident correlation, so this can't be gated
    # behind whether a webhook happens to be configured.
    last_incident_signal_at = Column(DateTime(timezone=True))
```

- [ ] **Step 4: Add Project's ProjectUpdate/ProjectResponse fields**

In `ProjectResponse` (main.py ~line 900), right after `kill_switch_webhook_url: Optional[str] = None`:

```python
    incident_webhook_url: Optional[str] = None
    incident_automation_enabled: bool = False
```

In `ProjectUpdate` (main.py ~line 1150), right after its own `kill_switch_webhook_url: Optional[str] = None`:

```python
    incident_webhook_url: Optional[str] = None
    incident_automation_enabled: Optional[bool] = None
```

(`update_project` needs no code change — it already applies `body.model_dump(exclude_unset=True)` generically via `setattr`.)

- [ ] **Step 5: Add the Incident Pydantic schemas**

Insert right before the `# ---... Continuous (online) scoring` comment block (main.py ~line 2792, i.e. directly after the policy-engine section ends):

```python
# ---------------------------------------------------------------------------
# Incidents (Phase 3) — read/lifecycle API. No POST: incidents are always
# system-correlated (see _attach_incident_signal), never manually created —
# manual human review is already trace_flags' job.
# ---------------------------------------------------------------------------
class IncidentSignalResponse(BaseModel):
    id: uuid.UUID
    source_type: str
    source_id: uuid.UUID
    reason: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class IncidentResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    category: str
    status: str
    severity: str
    opened_at: datetime
    acknowledged_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    resolved_note: Optional[str] = None
    recovery_suggestion: Optional[str] = None
    recovery_suggestion_json: Optional[dict] = None
    signals: list[IncidentSignalResponse] = []

    model_config = ConfigDict(from_attributes=True)


class IncidentUpdate(BaseModel):
    status: Literal["acknowledged", "resolved"]
    resolved_note: Optional[str] = None
```

- [ ] **Step 6: Verify it imports cleanly**

Run: `python -m py_compile main.py && python -c "import main; print(main.Incident, main.IncidentSignal)"`
Expected: prints the two class references, no traceback.

- [ ] **Step 7: Commit**

```bash
git add main.py
git commit -m "Add Incident/IncidentSignal models and Pydantic schemas"
```

---

### Task 3: Correlation engine + sync hook sites

This is the core of the feature: the function every signal source calls, and the two existing write paths (trace-flag creation, kill-switch halt creation) that call it synchronously — no new poller for these two.

**Files:**
- Modify: `main.py` — new helper functions (place them directly after the `Incident`/`IncidentSignal` models from Task 2, i.e. still before `SessionHalt`), plus two small edits to existing functions (`_create_trace_flag`, and the kill-switch halt creation inside `_compute_session_status`).

**Interfaces:**
- Consumes: `Incident`, `IncidentSignal` (Task 2), `Project`, `TraceFlag`, `AlertRule`, `_is_discord_webhook` (existing).
- Produces: `_attach_incident_signal(db, project_id, category, source_type, source_id, severity, reason) -> Optional[IncidentSignal]` — the one function every signal source calls; Task 4's alert-rule pass and Task 6's tests both call it indirectly (via the hooks) or directly.

- [ ] **Step 1: Add the category/severity constants and fingerprint helper**

Directly after the `IncidentSignal` model:

```python
# Assigned once, when a signal opens a NEW incident — an incident's
# category never changes afterward even if a later signal of a different
# flavor attaches to it. Heuristic, not a hard science: this is what lets
# an unrelated cost spike and a prompt-injection trip at the same time
# become two separate incidents instead of one confusing merged one.
_FLAG_SOURCE_CATEGORY = {"guardrail": "safety", "anomaly": "reliability", "manual": "reliability"}
_ALERT_METRIC_CATEGORY = {"avg_cost_per_request": "cost", "error_rate": "reliability", "p95_latency_ms": "performance"}
_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}


def _incident_signal_fingerprint(source_type: str, source_id, now: Optional[datetime] = None) -> str:
    """Deterministic per-signal-event identity, for the unique index that
    stops a race (two overlapping loop ticks, a retried request) from
    double-inserting the same signal. trace_flag/kill_switch signals are
    1:1 with an already-unique row id; alert_rule signals are minute-
    bucketed since the SAME rule legitimately produces a new signal every
    cooldown period, and only same-minute duplicates should be treated as
    "the same event"."""
    if source_type == "alert_rule":
        bucket = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M")
        return f"alert_rule:{source_id}:{bucket}"
    return f"{source_type}:{source_id}"
```

- [ ] **Step 2: Add the Discord-aware incident webhook sender**

Directly after the fingerprint helper — mirrors `_send_kill_switch_webhook`/`_format_discord_kill_switch_payload` exactly, sync (httpx.Client) since this is called from both sync request handlers and (via `asyncio.to_thread`) the background loop:

```python
def _format_discord_incident_payload(payload: dict) -> dict:
    lines = [
        f"**New incident opened: {payload['project_name']}**",
        f"Category: `{payload['category']}`  Severity: `{payload['severity']}`",
        f"Reason: {payload['reason']}",
        f"Opened at: {payload['opened_at']}",
    ]
    return {"content": "\n".join(lines)}


def _send_incident_webhook(url: str, payload: dict) -> bool:
    body = _format_discord_incident_payload(payload) if _is_discord_webhook(url) else payload
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.post(url, json=body)
            resp.raise_for_status()
        return True
    except Exception as e:
        print(f"[incidents] webhook POST to {url!r} failed: {e}")
        return False
```

- [ ] **Step 3: Add `_attach_incident_signal`**

Directly after `_send_incident_webhook`:

```python
def _attach_incident_signal(db: Session, project_id, category: str, source_type: str, source_id, severity: str, reason: str) -> Optional["IncidentSignal"]:
    """The one function every signal source calls. Finds the project's
    current non-resolved incident for this category and attaches a new
    signal to it, or opens a new incident if none exists. Fully
    synchronous (safe to call from a sync request handler OR via
    asyncio.to_thread from the background loop)."""
    project = db.get(Project, project_id)
    incident = (
        db.query(Incident)
        .filter(Incident.project_id == project_id, Incident.category == category, Incident.status != "resolved")
        .order_by(Incident.opened_at.desc())
        .first()
    )
    is_new_incident = incident is None
    if incident is None:
        incident = Incident(
            project_id=project_id, category=category, severity=severity,
            status="acknowledged" if project.incident_automation_enabled else "open",
        )
        db.add(incident)
        db.flush()  # populate incident.id before the FK reference below
    elif _SEVERITY_RANK[severity] > _SEVERITY_RANK[incident.severity]:
        incident.severity = severity

    signal = IncidentSignal(
        incident_id=incident.id, source_type=source_type, source_id=source_id,
        reason=reason, fingerprint=_incident_signal_fingerprint(source_type, source_id),
    )
    db.add(signal)
    try:
        db.commit()
    except IntegrityError:
        # Same fingerprint already recorded (a race between two callers) —
        # whichever call actually landed already did everything needed.
        db.rollback()
        return None

    if is_new_incident and project.incident_webhook_url:
        _send_incident_webhook(project.incident_webhook_url, {
            "project_name": project.name, "category": category, "severity": incident.severity,
            "reason": reason, "opened_at": incident.opened_at.isoformat(),
        })
    return signal
```

- [ ] **Step 4: Hook it into `_create_trace_flag`**

Change (main.py, the existing function):

```python
def _create_trace_flag(db: Session, trace: "Trace", source: str, reason: str, severity: str = "medium") -> "TraceFlag":
    flag = TraceFlag(trace_id=trace.id, source=source, severity=severity, reason=reason)
    db.add(flag)
    _sync_trace_flag_summary(db, trace)
    return flag
```

to:

```python
def _create_trace_flag(db: Session, trace: "Trace", source: str, reason: str, severity: str = "medium") -> "TraceFlag":
    flag = TraceFlag(trace_id=trace.id, source=source, severity=severity, reason=reason)
    db.add(flag)
    _sync_trace_flag_summary(db, trace)  # flushes — flag.id is populated by the time this returns
    _attach_incident_signal(
        db, trace.project_id, category=_FLAG_SOURCE_CATEGORY[source],
        source_type="trace_flag", source_id=flag.id, severity=severity, reason=reason,
    )
    return flag
```

- [ ] **Step 5: Hook it into the kill-switch halt creation**

In `_compute_session_status` (main.py ~line 1770), change:

```python
    reason_text = "; ".join(reasons)
    try:
        db.add(SessionHalt(project_id=project.id, session_id=session_id, reason=reason_text))
        db.commit()
        # Only on the path that actually just created the halt (not the
        # IntegrityError race below) — this is the one moment the trip
        # happens, so it's the one moment a notification should fire.
        if project.kill_switch_webhook_url:
            _send_kill_switch_webhook(project.kill_switch_webhook_url, {
                "project_name": project.name,
                "session_id": str(session_id),
                "reason": reason_text,
                "step_count": step_count,
                "total_cost": total_cost,
                "elapsed_seconds": elapsed_seconds,
                "halted_at": datetime.now(timezone.utc).isoformat(),
            })
    except IntegrityError:
```

to (capturing the new halt in a variable, and attaching a signal on the same only-on-actual-creation path the webhook already uses):

```python
    reason_text = "; ".join(reasons)
    try:
        halt = SessionHalt(project_id=project.id, session_id=session_id, reason=reason_text)
        db.add(halt)
        db.commit()
        # Only on the path that actually just created the halt (not the
        # IntegrityError race below) — this is the one moment the trip
        # happens, so it's the one moment a notification/signal should fire.
        if project.kill_switch_webhook_url:
            _send_kill_switch_webhook(project.kill_switch_webhook_url, {
                "project_name": project.name,
                "session_id": str(session_id),
                "reason": reason_text,
                "step_count": step_count,
                "total_cost": total_cost,
                "elapsed_seconds": elapsed_seconds,
                "halted_at": datetime.now(timezone.utc).isoformat(),
            })
        _attach_incident_signal(db, project.id, category="safety", source_type="kill_switch", source_id=halt.id, severity="high", reason=reason_text)
    except IntegrityError:
```

- [ ] **Step 6: Verify it still imports cleanly**

Run: `python -m py_compile main.py && python -c "import main"`
Expected: no traceback.

- [ ] **Step 7: Commit**

```bash
git add main.py
git commit -m "Add incident correlation engine, hook into trace_flag and kill-switch creation"
```

---

### Task 4: Background loop passes (alert-rule correlation, recovery guidance, automation auto-resolve)

**Files:**
- Modify: `main.py` — three new functions placed near `_evaluate_alert_rule`/`_alert_notification_loop` (~line 3250-3372), plus a small edit to `_alert_notification_loop` itself.

**Interfaces:**
- Consumes: `_attach_incident_signal` (Task 3), `_evaluate_alert_rule` (existing), `PROVIDERS["groq"]` (existing).
- Produces: nothing new consumed by later tasks — this is the last piece of backend behavior; Task 5's endpoints only read what these passes write.

- [ ] **Step 1: Add the alert-rule correlation pass**

Directly after `_evaluate_alert_rule`'s definition (main.py ~line 3249, right before the `# --- Alert webhook notifications ---` comment block):

```python
# Scans ALL enabled rules (unlike _due_alert_rules, which only returns
# rules with a webhook_url set) — a rule with no webhook configured should
# still raise an incident. Own cooldown field (last_incident_signal_at),
# separate from the webhook-only last_notified_at, so the two concerns
# don't gate each other.
def _run_incident_correlation_once(db: Session) -> None:
    rules = db.query(AlertRule).filter(AlertRule.enabled.is_(True)).all()
    for rule in rules:
        try:
            status = _evaluate_alert_rule(rule, db)
            if not status.triggered:
                continue

            now = datetime.now(timezone.utc)
            cooldown_elapsed = rule.last_incident_signal_at is None or (now - rule.last_incident_signal_at) >= timedelta(minutes=rule.window_minutes)
            if not cooldown_elapsed:
                continue

            reason = f"{rule.metric} {rule.comparator} {rule.threshold} (current: {status.current_value})"
            _attach_incident_signal(
                db, rule.project_id, category=_ALERT_METRIC_CATEGORY[rule.metric],
                source_type="alert_rule", source_id=rule.id, severity="medium", reason=reason,
            )
            rule.last_incident_signal_at = now
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"[incident-correlation] failed processing rule {rule.id}: {e}")
```

- [ ] **Step 2: Add the recovery-guidance generator + pass**

Directly after `_run_incident_correlation_once`:

```python
# Advisory recovery guidance — one Groq call per incident, synthesizing
# across every signal attached so far into a plain-language likely cause
# plus concrete next steps. Same client/fence-strip-then-json.loads
# convention _explain_error already uses. Never auto-executed — see the
# design spec's "recovery stays advisory" decision.
def _generate_incident_recovery_guidance(incident: "Incident", signals: list) -> dict:
    call_groq = PROVIDERS["groq"]
    signal_lines = "\n".join(f"- ({s.source_type}) {s.reason}" for s in signals)
    prompt = (
        "You are an on-call engineer's assistant looking at a correlated incident in an LLM "
        f"observability platform. Category: {incident.category}. Severity: {incident.severity}. "
        f"Signals contributing to this incident:\n{signal_lines}\n\n"
        "Respond with ONLY a JSON object, no other text, in this exact shape: "
        '{"likely_cause": "<1-2 plain-language sentences on what is probably wrong>", '
        '"suggested_actions": ["<short actionable step>", "..."], '
        '"confidence": "<one of low, medium, high>"}'
    )
    try:
        raw, _in_tok, _out_tok = call_groq(prompt)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        confidence = parsed.get("confidence") if parsed.get("confidence") in ("low", "medium", "high") else "low"
        return {
            "likely_cause": parsed.get("likely_cause") or "Unable to determine a likely cause.",
            "suggested_actions": parsed.get("suggested_actions") or [],
            "confidence": confidence,
        }
    except Exception as e:
        return {"likely_cause": f"(Couldn't generate a suggestion: {e})", "suggested_actions": [], "confidence": "low"}


# Regenerates for any non-resolved incident that either has never had
# guidance generated, or has a signal newer than its last generation AND
# recovery_generated_at is more than 5 minutes old — the rate limit that
# stops an LLM call firing on every single signal in a fast-moving
# incident (see the design spec).
def _run_incident_recovery_once(db: Session) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    incidents = (
        db.query(Incident)
        .filter(Incident.status != "resolved")
        .filter(or_(Incident.recovery_generated_at.is_(None), Incident.recovery_generated_at < cutoff))
        .all()
    )
    for incident in incidents:
        try:
            signals = db.query(IncidentSignal).filter(IncidentSignal.incident_id == incident.id).order_by(IncidentSignal.created_at.asc()).all()
            if not signals:
                continue
            has_new_signal = incident.recovery_generated_at is None or any(s.created_at > incident.recovery_generated_at for s in signals)
            if not has_new_signal:
                continue

            guidance = _generate_incident_recovery_guidance(incident, signals)
            incident.recovery_suggestion = (
                f"{guidance['likely_cause']} Suggested: {'; '.join(guidance['suggested_actions'])}"
                if guidance["suggested_actions"] else guidance["likely_cause"]
            )
            incident.recovery_suggestion_json = guidance
            incident.recovery_generated_at = datetime.now(timezone.utc)
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"[incident-recovery] failed generating guidance for incident {incident.id}: {e}")
```

- [ ] **Step 3: Add the "cleared" check + automation auto-resolve pass**

Directly after `_run_incident_recovery_once`:

```python
# Per-signal-type "is this still an active problem" check, used only by
# automation mode's auto-resolve pass below. A kill_switch signal is
# always considered cleared — a halt is a discrete past event (the
# session already stopped, and halts latch permanently), not an ongoing
# condition, so it never blocks an incident from auto-resolving.
def _incident_signal_cleared(db: Session, signal: "IncidentSignal") -> bool:
    if signal.source_type == "trace_flag":
        flag = db.get(TraceFlag, signal.source_id)
        return flag is None or flag.resolved_at is not None
    if signal.source_type == "kill_switch":
        return True
    if signal.source_type == "alert_rule":
        rule = db.get(AlertRule, signal.source_id)
        if rule is None:
            return True
        return not _evaluate_alert_rule(rule, db).triggered
    return True


# Bookkeeping-only automation (see the design spec's automation-scope
# decision): auto-acknowledge already happens synchronously in
# _attach_incident_signal at creation time. This pass handles the other
# half — auto-resolving once every attached signal individually clears.
# Never touches anything about what an agent is allowed to do.
def _run_incident_automation_once(db: Session) -> None:
    incidents = (
        db.query(Incident)
        .join(Project, Project.id == Incident.project_id)
        .filter(Incident.status != "resolved", Project.incident_automation_enabled.is_(True))
        .all()
    )
    for incident in incidents:
        try:
            signals = db.query(IncidentSignal).filter(IncidentSignal.incident_id == incident.id).all()
            if signals and all(_incident_signal_cleared(db, s) for s in signals):
                incident.status = "resolved"
                incident.resolved_at = datetime.now(timezone.utc)
                incident.resolved_note = "Auto-resolved: every underlying signal cleared."
                db.commit()
        except Exception as e:
            db.rollback()
            print(f"[incident-automation] failed processing incident {incident.id}: {e}")
```

- [ ] **Step 4: Wire all three passes into the existing loop**

Change `_alert_notification_loop` (main.py ~line 3362) from:

```python
async def _alert_notification_loop():
    while True:
        db = SessionLocal()
        try:
            await _run_alert_notifications_once(db)
        except Exception as e:
            print(f"[alert-notifications] loop iteration failed: {e}")
        finally:
            db.close()
        await asyncio.sleep(_ALERT_NOTIFICATION_INTERVAL_SECONDS)
```

to:

```python
async def _alert_notification_loop():
    while True:
        db = SessionLocal()
        try:
            await _run_alert_notifications_once(db)
        except Exception as e:
            print(f"[alert-notifications] loop iteration failed: {e}")
        finally:
            db.close()

        # Phase 3: incident correlation/recovery/automation share this same
        # 60s tick rather than adding new background loops. Each pass opens
        # its own session and is independently try/excepted so one failing
        # pass can't block the others.
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_correlation_once, db)
        except Exception as e:
            print(f"[incident-correlation] loop iteration failed: {e}")
        finally:
            db.close()

        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_automation_once, db)
        except Exception as e:
            print(f"[incident-automation] loop iteration failed: {e}")
        finally:
            db.close()

        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_recovery_once, db)
        except Exception as e:
            print(f"[incident-recovery] loop iteration failed: {e}")
        finally:
            db.close()

        await asyncio.sleep(_ALERT_NOTIFICATION_INTERVAL_SECONDS)
```

- [ ] **Step 5: Verify it still imports cleanly**

Run: `python -m py_compile main.py && python -c "import main"`
Expected: no traceback.

- [ ] **Step 6: Commit**

```bash
git add main.py
git commit -m "Add incident correlation, recovery guidance, and automation passes to the background loop"
```

---

### Task 5: API endpoints

**Files:**
- Modify: `main.py` — three new endpoints, placed directly after the `IncidentUpdate` schema from Task 2 (i.e. still before the `# Continuous (online) scoring` comment block).

**Interfaces:**
- Consumes: `Incident`, `IncidentSignal`, `IncidentResponse`, `IncidentSignalResponse`, `IncidentUpdate` (Task 2); `get_db`, `get_current_project` (existing).
- Produces: `GET /incidents`, `GET /incidents/{id}`, `PATCH /incidents/{id}` — used by Task 6's tests.

- [ ] **Step 1: Add the list and detail endpoints**

```python
@app.get("/incidents", response_model=list[IncidentResponse])
def list_incidents(status: Optional[str] = None, category: Optional[str] = None, db: Session = Depends(get_db), project: Project = Depends(get_current_project)):
    query = db.query(Incident).filter(Incident.project_id == project.id)
    if status is not None:
        query = query.filter(Incident.status == status)
    if category is not None:
        query = query.filter(Incident.category == category)
    incidents = query.order_by(Incident.opened_at.desc()).all()

    results = []
    for incident in incidents:
        signals = db.query(IncidentSignal).filter(IncidentSignal.incident_id == incident.id).order_by(IncidentSignal.created_at.asc()).all()
        results.append(IncidentResponse(
            **IncidentResponse.model_validate(incident).model_dump(exclude={"signals"}),
            signals=[IncidentSignalResponse.model_validate(s) for s in signals],
        ))
    return results


@app.get("/incidents/{incident_id}", response_model=IncidentResponse)
def get_incident(incident_id: uuid.UUID, db: Session = Depends(get_db), project: Project = Depends(get_current_project)):
    incident = db.get(Incident, incident_id)
    if incident is None or incident.project_id != project.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    signals = db.query(IncidentSignal).filter(IncidentSignal.incident_id == incident.id).order_by(IncidentSignal.created_at.asc()).all()
    return IncidentResponse(
        **IncidentResponse.model_validate(incident).model_dump(exclude={"signals"}),
        signals=[IncidentSignalResponse.model_validate(s) for s in signals],
    )
```

- [ ] **Step 2: Add the state-machine-enforcing update endpoint**

```python
# open -> acknowledged -> resolved only. resolved is terminal — no
# transition out (see the design spec's state machine). A new signal for
# this (project, category) after resolution opens a NEW incident rather
# than reviving this one (already guaranteed by _attach_incident_signal's
# "status != resolved" lookup).
_INCIDENT_TRANSITIONS = {
    "open": {"acknowledged", "resolved"},
    "acknowledged": {"resolved"},
    "resolved": set(),
}


@app.patch("/incidents/{incident_id}", response_model=IncidentResponse)
def update_incident(incident_id: uuid.UUID, update: IncidentUpdate, db: Session = Depends(get_db), project: Project = Depends(get_current_project)):
    incident = db.get(Incident, incident_id)
    if incident is None or incident.project_id != project.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    if update.status not in _INCIDENT_TRANSITIONS[incident.status]:
        raise HTTPException(status_code=409, detail=f"Cannot transition incident from {incident.status!r} to {update.status!r}")

    now = datetime.now(timezone.utc)
    incident.status = update.status
    if update.status == "acknowledged":
        incident.acknowledged_at = now
    elif update.status == "resolved":
        incident.resolved_at = now
        incident.resolved_note = update.resolved_note

    db.commit()
    db.refresh(incident)
    signals = db.query(IncidentSignal).filter(IncidentSignal.incident_id == incident.id).order_by(IncidentSignal.created_at.asc()).all()
    return IncidentResponse(
        **IncidentResponse.model_validate(incident).model_dump(exclude={"signals"}),
        signals=[IncidentSignalResponse.model_validate(s) for s in signals],
    )
```

- [ ] **Step 3: Manual smoke test before writing the full suite**

Start the backend locally (`python -m uvicorn main:app --port 8010`, Postgres up, migration from Task 1 applied), then:

```bash
curl -s -X POST http://localhost:8010/auth/login -H "Content-Type: application/json" -d '{"email":"phase3-smoke@example.com","password":"x"}'
```

Use the returned `session_token` to create a project, get its `api_key`, then:

```bash
curl -s http://localhost:8010/incidents -H "X-API-Key: <api_key>"
```

Expected: `[]` (empty list, 200), not a 500 — confirms the models/migration/endpoint all agree on shape.

- [ ] **Step 4: Commit**

```bash
git add main.py
git commit -m "Add GET/PATCH /incidents endpoints"
```

---

### Task 6: Test suite

**Files:**
- Create: `tests/test_phase3_incidents.py`

**Interfaces:**
- Consumes: `admin_headers`, `project`, `api_headers` fixtures (existing, `tests/conftest.py`); every endpoint from Task 5.

**Note on runtime:** three of these tests poll for a background-loop tick (60s cadence, same `_ALERT_NOTIFICATION_INTERVAL_SECONDS` as the existing alert-notification loop) and will each take up to ~70s in the worst case — this is a real increase to the suite's total runtime (currently ~260s for 18 tests), consistent with the tradeoff already accepted for reusing the existing loop instead of adding a faster-polling one.

- [ ] **Step 1: Write the test file**

```python
"""
Integration tests for AgentOps Phase 3 (AIOps incidents): correlating
AlertRule triggers, trace_flags, and kill-switch halts into project+
category-scoped incidents, with fingerprint dedup, an explicit state
machine, recovery guidance, and bookkeeping-only automation.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os
import time
import uuid
from datetime import datetime, timezone

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _get(path, headers, params=None):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers, params=params or {})
    resp.raise_for_status()
    return resp.json()


def _patch(path, headers, body=None):
    resp = requests.patch(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    return resp


def _create_guardrail_incident(api_headers):
    """Shared setup: a deterministic always-fail scorer trips a guardrail
    flag, which synchronously opens a category='safety' incident — no
    background-loop wait needed, since trace_flag signals attach inline."""
    scorer = _post("/scorers", api_headers, {
        "name": f"phase3-always-fail-{uuid.uuid4().hex[:8]}",
        "prompt_template": "Respond with exactly the word: fail",
        "choice_scores": {"pass": 1.0, "fail": 0.0},
        "pass_threshold": 0.5,
    })
    trace = _post("/traces", api_headers, {"name": "phase3_guardrail_incident_test"})
    result = _post("/guardrails/check", api_headers, {
        "trace_id": trace["id"], "scorer_slug": scorer["slug"], "text": "irrelevant text",
    })
    assert result["flagged"] is True
    return trace


# --- Correlation from sync-hooked sources (fast — no loop wait) ---

def test_guardrail_flag_opens_safety_incident_with_trace_flag_signal(api_headers):
    _create_guardrail_incident(api_headers)
    incidents = _get("/incidents", api_headers, {"status": "open", "category": "safety"})
    assert len(incidents) >= 1
    matching = incidents[0]
    assert matching["category"] == "safety"
    assert matching["status"] == "open"
    assert any(s["source_type"] == "trace_flag" and "guardrail" in s["reason"] for s in matching["signals"])


def test_anomaly_and_guardrail_open_separate_incidents(api_headers):
    # Anomaly: three identical repeated tool calls, same trick Phase 2's tests use.
    anomaly_trace = _post("/traces", api_headers, {"name": "phase3_anomaly_test"})
    for _ in range(3):
        _post("/spans", api_headers, {"trace_id": anomaly_trace["id"], "step_name": "dup", "input": "same"})
    _patch(f"/traces/{anomaly_trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    _create_guardrail_incident(api_headers)

    reliability = _get("/incidents", api_headers, {"category": "reliability"})
    safety = _get("/incidents", api_headers, {"category": "safety"})
    assert len(reliability) >= 1
    assert len(safety) >= 1
    assert reliability[0]["id"] != safety[0]["id"]


def test_kill_switch_halt_creates_safety_incident_once(admin_headers, project, api_headers):
    requests.patch(
        f"{BACKEND_URL}/projects/{project['id']}", headers=admin_headers, json={"name": "phase3-killswitch", "max_session_steps": 1},
    ).raise_for_status()

    session_id = str(uuid.uuid4())
    trace = _post("/traces", api_headers, {"name": "phase3_killswitch_test", "session_id": session_id})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "s1"})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "s2"})

    # Check status three times — must not produce more than one signal (the
    # halt only fires _attach_incident_signal on the path that actually
    # creates the SessionHalt, matching the existing webhook precedent).
    for _ in range(3):
        status = _get(f"/sessions/{session_id}/status", api_headers)
    assert status["halted"] is True

    incidents = _get("/incidents", api_headers, {"category": "safety"})
    matching = next(i for i in incidents if any(s["source_type"] == "kill_switch" for s in i["signals"]))
    kill_switch_signals = [s for s in matching["signals"] if s["source_type"] == "kill_switch"]
    assert len(kill_switch_signals) == 1


# --- State machine ---

def test_state_machine_transitions_and_no_reopen(api_headers):
    trace = _create_guardrail_incident(api_headers)
    incidents = _get("/incidents", api_headers, {"status": "open", "category": "safety"})
    incident_id = incidents[0]["id"]

    ack = _patch(f"/incidents/{incident_id}", api_headers, {"status": "acknowledged"})
    assert ack.status_code == 200
    assert ack.json()["status"] == "acknowledged"

    resolved = _patch(f"/incidents/{incident_id}", api_headers, {"status": "resolved", "resolved_note": "handled"})
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "resolved"
    assert resolved.json()["resolved_note"] == "handled"

    # resolved is terminal — no transition out.
    reopen_attempt = _patch(f"/incidents/{incident_id}", api_headers, {"status": "acknowledged"})
    assert reopen_attempt.status_code == 409


def test_new_signal_after_resolution_opens_new_incident(api_headers):
    _create_guardrail_incident(api_headers)
    first = _get("/incidents", api_headers, {"status": "open", "category": "safety"})[0]
    _patch(f"/incidents/{first['id']}", api_headers, {"status": "resolved"})

    _create_guardrail_incident(api_headers)
    open_safety = _get("/incidents", api_headers, {"status": "open", "category": "safety"})
    assert len(open_safety) >= 1
    assert all(i["id"] != first["id"] for i in open_safety)


# --- Alert-rule correlation + recovery guidance (slow — up to ~70s each) ---

def test_alert_rule_trigger_creates_reliability_incident(api_headers):
    _post("/alert-rules", api_headers, {
        "name": "phase3-error-rate", "metric": "error_rate", "comparator": ">", "threshold": 0.0, "window_minutes": 60,
    })
    trace = _post("/traces", api_headers, {"name": "phase3_alert_trigger_test"})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "s1", "error": "boom"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": None, "ended_at": _now_iso()})

    deadline = time.time() + 75
    incidents = []
    while time.time() < deadline:
        incidents = _get("/incidents", api_headers, {"category": "reliability"})
        if any(any(s["source_type"] == "alert_rule" for s in i["signals"]) for i in incidents):
            break
        time.sleep(3)

    matching = next(i for i in incidents if any(s["source_type"] == "alert_rule" for s in i["signals"]))
    assert matching["category"] == "reliability"


def test_recovery_guidance_populated_within_one_loop_tick(api_headers):
    _create_guardrail_incident(api_headers)
    incident_id = _get("/incidents", api_headers, {"status": "open", "category": "safety"})[0]["id"]

    deadline = time.time() + 75
    detail = None
    while time.time() < deadline:
        detail = _get(f"/incidents/{incident_id}", api_headers)
        if detail["recovery_suggestion"] is not None:
            break
        time.sleep(3)

    assert detail["recovery_suggestion"] is not None
    assert detail["recovery_suggestion_json"] is not None
    assert set(detail["recovery_suggestion_json"].keys()) == {"likely_cause", "suggested_actions", "confidence"}
    assert detail["recovery_suggestion_json"]["confidence"] in ("low", "medium", "high")


# --- Automation mode (bookkeeping only) ---

def test_automation_mode_auto_acknowledges_and_auto_resolves(admin_headers, project, api_headers):
    requests.patch(
        f"{BACKEND_URL}/projects/{project['id']}", headers=admin_headers,
        json={"name": "phase3-automation", "incident_automation_enabled": True},
    ).raise_for_status()

    scorer = _post("/scorers", api_headers, {
        "name": f"phase3-automation-fail-{uuid.uuid4().hex[:8]}",
        "prompt_template": "Respond with exactly the word: fail",
        "choice_scores": {"pass": 1.0, "fail": 0.0},
        "pass_threshold": 0.5,
    })
    trace = _post("/traces", api_headers, {"name": "phase3_automation_test"})
    _post("/guardrails/check", api_headers, {"trace_id": trace["id"], "scorer_slug": scorer["slug"], "text": "x"})

    # Auto-acknowledge happens synchronously at creation — no loop wait.
    incident = _get("/incidents", api_headers, {"category": "safety"})[0]
    assert incident["status"] == "acknowledged"
    flag_id = incident["signals"][0]["source_id"]

    # Resolve the underlying trace_flag directly — this is what "clears" a
    # trace_flag signal for the auto-resolve check.
    requests.patch(f"{BACKEND_URL}/traces/{trace['id']}/flags/{flag_id}", headers=api_headers, json={}).raise_for_status()

    deadline = time.time() + 75
    final_status = None
    while time.time() < deadline:
        final_status = _get(f"/incidents/{incident['id']}", api_headers)["status"]
        if final_status == "resolved":
            break
        time.sleep(3)

    assert final_status == "resolved"
```

- [ ] **Step 2: Run the new tests in isolation first**

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/test_phase3_incidents.py -v`
Expected: some failures are likely on the first run (this is normal — fix in place per the next step, don't move on with red tests).

- [ ] **Step 3: Fix any failures**

Common ones to check first: 404s (an endpoint route ordering or auth-dependency mismatch — compare against Task 5's exact code), `KeyError` on a response field (a schema/model_dump mismatch — compare Task 2's schema fields against what the test reads), assertion failures on category/severity (double check `_FLAG_SOURCE_CATEGORY`/`_ALERT_METRIC_CATEGORY` mappings from Task 3 match what each test expects). Iterate until every test in this file passes.

- [ ] **Step 4: Run the full suite (Phase 1 + 2 + 3) to check for regressions**

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/ -v`
Expected: all tests pass — the pre-existing 18 (Phase 1 + 2) plus the new Phase 3 tests.

- [ ] **Step 5: Add the migration to CI's test step context and commit**

```bash
git add tests/test_phase3_incidents.py
git commit -m "Add Phase 3 incidents test suite"
```

---

### Task 7: Final regression pass

**Files:** none (verification only).

- [ ] **Step 1: Full clean-restart regression run**

Restart the local backend fresh (kill any `--reload` zombie processes first, matching this session's established Windows gotcha), confirm the migration from Task 1 is applied, then:

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/ -v`
Expected: 100% pass, including all pre-existing Phase 1/2 tests — proves Task 3's edits to `_create_trace_flag` and the kill-switch halt path didn't regress anything those tests already cover.

- [ ] **Step 2: `git status` sanity check**

Run: `git status --short`
Expected: clean (everything from Tasks 1-6 already committed) — nothing staged/unstaged left over.

- [ ] **Step 3: Report completion**

Summarize what shipped (incidents correlating alert rules/trace_flags/kill-switch, fingerprint dedup, state machine, recovery guidance, automation toggle) and that nothing has been pushed/deployed yet — matching this project's established pattern of an explicit push/deploy confirmation step before touching `origin/main` or Render.
