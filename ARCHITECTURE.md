# Architecture Notes

Running log of the significant design decisions behind each phase of this
platform's evolution from an LLM observability tool into a full AgentOps/
AIOps platform. Each phase gets its own section, appended below the last —
read top to bottom for the history, or jump to the phase you care about.

## Phase 1 — AgentOps Core

**What shipped:** agent identity, shared agent memory, agent-to-agent
messaging, a per-agent cost dashboard, and live session status over SSE.

**Why it matters.** Traces/spans/scores answer "what happened in one run."
None of them answer "which agent is spending the money," "what does this
agent remember from three turns ago," "can two agents hand off work to each
other," or "is this session about to run away from me right now." Phase 1
adds exactly those four things, without touching how traces/spans/scores/
scorers/experiments/alerts/kill-switch already work.

### Agent identity — a new `agents` table, auto-registered by name

Memory and messaging both need a stable identity: messaging needs a real
foreign key for sender/recipient, the cost dashboard needs a grouping key.
`trace.name` isn't reliable for this — it's a workflow/step label, and real
integrations already use it inconsistently. `agents` is project-scoped,
same shape as `scorers`. `traces.agent_id` is a new nullable column
(`ON DELETE SET NULL`); `TraceCreate.agent_name` is a write-only field the
backend resolves via `_get_or_create_agent` — pass it, or don't. Every
existing trace and integration is unaffected either way.

`_get_or_create_agent` is deliberately NOT `create_scorer`'s pattern.
`create_scorer` always inserts a new row and disambiguates name collisions
with a numeric suffix (two scorers can share a display name). An agent name
used across many calls must resolve to the *same* row every time instead —
so this is a real find-or-create: query first, insert only if absent,
`IntegrityError` → re-query on a creation race.

### Shared memory — one table, a `scope` column

`agent_memory(project_id, agent_id, session_id, scope, key, value JSONB,
expires_at, ...)`. `short_term` entries carry an `expires_at` (from a
caller-supplied `ttl_seconds`); `long_term` entries leave it NULL.
`agent_id`/`session_id` are both nullable — NULL `agent_id` is project-
global memory, NULL `session_id` is memory that persists across sessions.

Postgres treats NULL as distinct-from-itself in a plain `UNIQUE`
constraint, so a straightforward unique index on the logical key
`(project_id, agent_id, session_id, scope, key)` wouldn't actually stop two
concurrent writers of "no agent, no session" from creating duplicate rows.
The migration instead builds the unique index on `COALESCE(agent_id,
'00000000-...'::uuid)` / `COALESCE(session_id, '00000000-...'::uuid)` —
NULL is normalized to a sentinel *for uniqueness purposes only*; the stored
columns stay genuinely NULL. The write path still does a NULL-safe lookup
in Python (`.is_(None)` vs `==`) before deciding insert-vs-update, then
catches the (now real) `IntegrityError` on a genuine race.

### Messaging — a durable Postgres inbox, not a queue

`agent_messages(project_id, from_agent_id, to_agent_id NULL, session_id,
content JSONB, read_at)`. `to_agent_id IS NULL` means broadcast — visible in
every agent's inbox in the project. This is intentionally NOT built on
Redis/pub-sub: Phase 2 introduces Redis Streams for async trace ingestion
specifically, and pulling in that infra a phase early for messaging would
be a bigger change than this needed. A durable table read via polling GET
is consistent with every other read in this app; if message volume or
latency ever demands push delivery, that's a natural Phase-2-adjacent
upgrade once Redis Streams already exists for another reason.

### Per-agent cost dashboard — aggregated in Python, like the rest of this app

`GET /agents/costs` loads matching `Trace` rows and aggregates in Python
(group by `agent_id`, sum cost/tokens, average latency) rather than a raw
SQL `GROUP BY` — the same approach `_evaluate_alert_rule` and
`analyze_experiment` already use elsewhere in `main.py`. Consistent with
house style; fine at this app's real data volumes (hundreds to low
thousands of traces per project).

### Live session status — SSE, not WebSocket or polling

Session status (steps/cost/elapsed/halted) is one-directional — the server
pushes state, the client only watches — so a full-duplex WebSocket brings
connection-lifecycle machinery (ping/pong keep-alive, reconnect logic) this
use case doesn't need. Plain polling was the simplest option but wasn't
what was asked for and adds request overhead per open dashboard tab for no
real benefit over a push model.

The one real wrinkle: this app's data-plane auth (`X-API-Key`) is a header,
and the browser's `EventSource` API cannot set custom request headers. The
options were a query-string API key (rejected — that leaks a secret into
URLs, proxy access logs, and browser history) or a `fetch()`-based stream
reader that keeps the key as a header. `GET /sessions/{id}/stream` is
therefore authenticated exactly like every other data-plane route; the
frontend's `useSessionStream` hook (`frontend/src/hooks/useSessionStream.js`)
reads `response.body.getReader()` and manually parses `data: ...\n\n`
frames instead of using `EventSource`. Server-side, the endpoint reuses the
exact same computation as the existing `GET /sessions/{id}/status` via a
shared `_compute_session_status` helper — no duplicated logic between the
polled and streamed versions — polls it every 2 seconds via
`asyncio.to_thread` (same non-blocking pattern as the pre-existing
`_online_scoring_loop`/`_alert_notification_loop` background tasks), only
emits a frame when the payload actually changed, and caps itself at ~10
minutes so an abandoned browser tab can't hold a connection open forever.

### Testing — a real pytest suite, introduced this phase

This repo had zero automated tests before Phase 1 (no pytest, no `assert`
anywhere — every prior feature was verified by hand: manual scripts or live
curl/Playwright checks). `tests/conftest.py` + `tests/test_agents_phase1.py`
hit a real, already-running backend + Postgres over real HTTP — the same
convention every "test-like" script in this repo already used
(`test_error_explanation.py`, `score_trace.py`, `scripts/run_eval_gate.py`),
just with real assertions instead of print statements. This avoided
introducing FastAPI's `TestClient`/dependency-override machinery and a
separate test-database story into a codebase that never needed either.
Wired into CI (`.github/workflows/eval.yml`) as a build-failing step —
unlike the eval-gate script (which checks LLM-output quality/regressions
and doesn't fail the build by default), a failing pytest test should, and
does, fail the build.

### New surface area

- **Migration**: `add_agentops_phase1.sql`
- **Endpoints**: `GET /agents`, `POST/GET/DELETE /agents/memory`,
  `POST/GET/PATCH /agents/messages`, `GET /agents/costs`,
  `GET /sessions/{id}/stream`; `POST /traces` gained an optional
  `agent_name` field
- **SDK** (`sdk/llmobs/__init__.py`): `Client.list_agents`, `remember`,
  `recall`, `forget`, `send_message`, `get_messages`,
  `mark_message_read`, `agent_costs`; `traced(..., agent_name=...)`
- **Frontend**: `frontend/src/pages/Agents.jsx` (nav: Analytics → Agents),
  `frontend/src/hooks/useSessionStream.js`
- **Tests**: `tests/conftest.py`, `tests/test_agents_phase1.py`
