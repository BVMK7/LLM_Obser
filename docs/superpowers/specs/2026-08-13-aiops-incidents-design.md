# AgentOps Phase 3: AIOps Incidents & Recovery Guidance

## Context

Phase 1 (agent identity/memory/messaging/cost dashboard/live session status)
and Phase 2 (async ingestion, `trace_flags` review queue, advisory policy
engine, failure classification) are shipped and deployed. This phase
correlates the signals those systems already produce — instead of a
triggered `AlertRule`, a flagged trace, and a kill-switch halt each living in
total isolation, they now feed one **incident** record per project per
problem category, with an LLM-generated recovery suggestion and an explicit
lifecycle a human (or, optionally, the system itself) works through.

Two scope decisions, confirmed with the user before this was written:

- **Correlate everything.** An incident is auto-opened/updated from any of
  the three existing signal sources — a triggered `AlertRule`, a burst of
  `trace_flags`, or a `SessionHalt` (kill-switch). Today these can't see
  each other; that's the actual gap this phase closes.
- **Recovery stays advisory.** Every existing safety mechanism in this app
  (kill-switch, guardrails, the policy engine) reports status and lets the
  caller decide — nothing auto-blocks a write. This phase does not change
  that. "Recovery" means a suggested next step for a human, not an
  auto-executed action against an agent's actual traffic. The one exception
  is the automation toggle described below, which only ever automates
  *incident bookkeeping* (acknowledge/resolve), never anything that touches
  what an agent is allowed to do.

## Data model

```sql
CREATE TABLE incidents (
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
-- The lookup every signal-attach does: "is there a non-terminal incident
-- for this project+category to attach to?"
CREATE INDEX idx_incidents_open_lookup ON incidents(project_id, category, status) WHERE status != 'resolved';

CREATE TABLE incident_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('alert_rule', 'trace_flag', 'kill_switch')),
    source_id UUID NOT NULL,
    reason TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_incident_signals_fingerprint ON incident_signals(fingerprint);
CREATE INDEX idx_incident_signals_incident_id ON incident_signals(incident_id);

ALTER TABLE projects ADD COLUMN incident_webhook_url TEXT;
ALTER TABLE projects ADD COLUMN incident_automation_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alert_rules ADD COLUMN last_incident_signal_at TIMESTAMPTZ;
```

`incident_automation_enabled` defaults to `false` — every existing project
stays fully human-in-the-loop unless someone opts in.

## Category

A fixed 4-value enum, assigned once when a signal opens a *new* incident
(an incident's category never changes after that, even if a later signal
of a different flavor attaches to it):

| Signal | Category |
|---|---|
| `AlertRule.metric == "avg_cost_per_request"` | `cost` |
| `AlertRule.metric == "error_rate"` | `reliability` |
| `AlertRule.metric == "p95_latency_ms"` | `performance` |
| `trace_flag` source `guardrail` | `safety` |
| `trace_flag` source `anomaly` | `reliability` |
| `trace_flag` source `manual` | `reliability` |
| `kill_switch` halt | `safety` |

This is a heuristic, not a hard science — it's what lets an unrelated cost
spike and a prompt-injection trip happening at the same time become two
separate incidents instead of one confusing merged one, which was the real
gap in grouping by project alone.

## Grouping & attachment

One non-terminal (`open` or `acknowledged`) incident per `(project_id,
category)` at a time. When a signal fires:

1. Look up an incident for this `(project_id, category)` where
   `status != 'resolved'`.
2. If found, insert a new `incident_signals` row against it (severity may
   escalate — see below).
3. If not found, create a new `incidents` row (`status='open'`, `severity`
   from the signal) and insert the first `incident_signals` row against it.

Severity escalation: an incident's `severity` is raised to match its
highest-severity signal so far (never lowered automatically — only
resolving clears it). Each signal's own severity, at the point it's
created: a `trace_flag` signal reuses that flag's own `severity` column
(already `low`/`medium`/`high` from Phase 2); a `kill_switch` signal is
always `high` (an active halt is the most serious existing signal in this
app); an `alert_rule` signal is always `medium`.

### Fingerprint (dedup)

Every `incident_signals` insert computes a `fingerprint` and the table has
a unique index on it; a duplicate insert (a race between two loop ticks, a
retried request) raises `IntegrityError`, which the caller catches, rolls
back, and treats as a no-op — the same pattern `_get_or_create_agent`
already uses for exactly this kind of race.

- `trace_flag` signal: `f"trace_flag:{flag.id}"` — a given flag can only
  ever produce one signal.
- `kill_switch` signal: `f"kill_switch:{halt.id}"` — a halt is created once
  (latches permanently) and its id is stable.
- `alert_rule` signal: `f"alert_rule:{rule.id}:{now:%Y%m%dT%H%M}"` —
  minute-bucketed, so two overlapping loop ticks for the same still-
  triggered rule can't double-insert; a genuinely new signal each time the
  rule's own cooldown (`last_incident_signal_at`, independent of the
  existing webhook-only `last_notified_at`) allows one is intended, not a
  duplicate.

## Where signals attach (no new background loop)

Reusing existing write paths, matching Phase 2's `_create_trace_flag`
precedent — no new poller:

- **Kill-switch halt**: hooked in right where `SessionHalt` is inserted
  (next to the existing webhook call), reason text reused from the halt's
  own `reason`.
- **Trace flags**: hooked inside `_create_trace_flag` — every manual/
  anomaly/guardrail flag already funnels through this one function, so this
  is a single call site.
- **Alert rules**: the existing `_alert_notification_loop` only scans rules
  that have a `webhook_url` set (via `_due_alert_rules`) — too narrow for
  incidents, since a rule with no webhook configured should still raise an
  incident. The loop gains a second, independent pass: scan *all* enabled
  rules each tick, evaluate, and if triggered and
  `last_incident_signal_at` cooldown (`window_minutes`, same cooldown
  shape as the existing webhook one) has elapsed, attach a signal.

## State machine

```
open ──────► acknowledged ──────► resolved
  └──────────────────────────────►┘
```

- `open → acknowledged`: a human claims it (`PATCH /incidents/{id}`,
  `status="acknowledged"`).
- `open → resolved` / `acknowledged → resolved`: resolved directly or after
  acknowledging (`resolved_note` optional).
- `resolved` is terminal — no transition out. A `PATCH` attempting to
  change a resolved incident's status returns `409 Conflict`. New signals
  for that `(project_id, category)` after resolution open a **new**
  incident rather than reviving the old one (this is what the "is there a
  non-terminal incident" lookup above already guarantees).

## Recovery guidance

`_generate_incident_recovery_guidance(incident, signals)` — a new Groq
call (same client `_explain_error` already uses) prompted to return JSON:

```json
{"likely_cause": "...", "suggested_actions": ["...", "..."], "confidence": "low|medium|high"}
```

Parsed with the same fence-strip-then-`json.loads` convention already used
elsewhere in this codebase. Stored as both `recovery_suggestion` (a
one-line prose rendering, for a simple read) and `recovery_suggestion_json`
(the structured form, for a UI that wants to render `suggested_actions` as
a checklist).

Dispatched via `BackgroundTasks` whenever a new signal attaches to an
incident (same non-blocking pattern as Phase 2's failure classification),
but only regenerated if `recovery_generated_at` is more than 5 minutes old
— guards against an LLM call firing on every single signal in a fast-moving
incident.

## Automation mode (bookkeeping only)

`Project.incident_automation_enabled` — when `true` for a project:

- A newly-opened incident is immediately set to `acknowledged` (skips the
  manual claim step).
- The same background loop tick that does alert-rule correlation also
  checks every open/acknowledged incident in automation-enabled projects:
  if **every** attached signal is individually "cleared," the incident
  auto-transitions to `resolved` (`resolved_note` set to a fixed
  system-generated string noting it was automatic).

"Cleared" per signal type:

| Signal | Cleared when |
|---|---|
| `trace_flag` | that flag's own `resolved_at` is set (via the existing per-flag/bulk resolve endpoints) |
| `alert_rule` | the rule's next evaluation is no longer triggered |
| `kill_switch` | always — a halt is a discrete past event (the session already stopped, and halts latch permanently), not an ongoing condition, so it never blocks auto-resolve |

Explicitly **not** automated: anything that would change what an agent is
allowed to do (no auto-created policy rules, no forced halts beyond what
the kill-switch already does on its own). This was a direct design fork
resolved with the user — automation here is scoped to incident lifecycle
bookkeeping only, not agent-facing enforcement, since nothing in this
platform can actually force an agent to stop today (the SDK's checks are
advisory; the agent decides).

`Project.incident_webhook_url` (mirrors the existing
`kill_switch_webhook_url`) posts a notification (reusing the existing
Discord-aware payload formatter) when a **new** incident opens — not on
every signal attach, and not on auto-resolve.

## API surface

- `GET /incidents` — list, filterable by `status` and `category`.
- `GET /incidents/{id}` — detail, including its full `incident_signals`
  list.
- `PATCH /incidents/{id}` — `status` transition (`acknowledged`/
  `resolved`, with optional `resolved_note`); rejects invalid transitions
  with `409`.
- No `POST /incidents` — incidents are always system-correlated, never
  manually created (manual review is already `trace_flags`' job).
- `PATCH /projects/{id}` gains `incident_webhook_url` and
  `incident_automation_enabled` alongside the existing kill-switch fields.

## Explicitly out of scope for this turn

- SDK exposure — this is an admin/dashboard-facing concept, not something
  an agent calls (unlike guardrails/kill-switch/policy engine).
- Frontend (a new Incidents dashboard page, Project Settings additions for
  the two new fields) — deferred to a follow-up turn, same split as
  Phase 1 and Phase 2.
- Real automated remediation (auto-blocking a model, forcibly halting a
  session beyond the existing kill-switch) — would require an actual
  enforcement point this platform doesn't have; out of scope unless a
  future turn adds one deliberately.
- Time-window-based clustering (e.g. grouping only signals within N
  minutes of each other) — the `(project_id, category, non-resolved)`
  grouping is deliberately simpler for v1; can be revisited if it proves
  too coarse in practice.
- **Enforcing "one non-terminal incident per (project, category)" under
  concurrency.** The lookup-then-insert in `_attach_incident_signal` has no
  lock and no unique constraint behind it (`idx_incidents_open_lookup` is a
  plain, non-unique partial index) — two truly concurrent signals for the
  same project+category (e.g. two simultaneous `POST /guardrails/check`
  calls) can each find no open incident and each create one, producing a
  split incident with signals scattered across both records. The
  `order_by(opened_at.desc())` lookup means later signals converge on the
  newest one, which limits the damage but doesn't prevent it. A real fix
  (a unique partial index on `incidents(project_id, category) WHERE status
  != 'resolved'`) is deliberately deferred: it would need to land alongside
  `_attach_incident_signal`'s SAVEPOINT-based signal insert (so the
  resulting `IntegrityError` isn't misattributed to a fingerprint
  collision), which is more surgery than this v1 warrants. Known
  limitation, not a correctness bug in the common case. One specific
  sub-case: because the new-incident row is `flush()`ed *before* the
  signal insert's own SAVEPOINT, a fingerprint collision on that signal
  (realistically only reachable via concurrent `alert_rule` correlation —
  its fingerprint is minute-bucketed, so two racing loop ticks for the
  same rule can collide) rolls back the signal but leaves the already-
  flushed, signal-less incident to be committed anyway. A narrow race,
  same root cause as the rest of this limitation.

## Testing plan

New `tests/test_phase3_incidents.py`, same live-server convention as the
existing suites:

- A triggered `AlertRule` (no webhook needed) produces an `incidents` row
  with the right category; a second evaluation while still triggered (past
  cooldown) adds a second `incident_signals` row to the *same* incident,
  not a new one.
- Three anomaly-triggering traces in the same project produce one incident
  with `category="reliability"`; a guardrail trip in the same project at
  the same time produces a **separate** incident (`category="safety"`) —
  proves category-based grouping actually separates unrelated problems.
- A duplicate signal insert (same fingerprint) is a no-op, not a 500 or a
  duplicate row.
- State machine: `open → acknowledged → resolved` succeeds;
  `PATCH` on an already-`resolved` incident returns `409`; a new signal
  after resolution opens a new incident rather than reviving the old one.
- Recovery guidance: `recovery_suggestion`/`recovery_suggestion_json` are
  `None` immediately after a signal attaches, then populated within a
  short poll window (same async-classification-polling pattern as Phase
  2's tests); `recovery_generated_at` doesn't advance again from a second
  signal arriving less than 5 minutes later.
- Automation mode: with `incident_automation_enabled=true`, a new incident
  is immediately `acknowledged` (never sits in `open`); once its one
  `trace_flag` signal is resolved, the incident auto-transitions to
  `resolved` on the next loop tick without any `PATCH /incidents/{id}`
  call.
