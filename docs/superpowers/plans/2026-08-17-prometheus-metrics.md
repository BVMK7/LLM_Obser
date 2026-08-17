# Prometheus Metrics Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standard `GET /metrics` endpoint exposing HTTP request metrics (route-template-labeled counts/latency) and background-loop health (last-tick timestamp + duration, per named loop/pass), so external monitoring tools can be pointed at this app.

**Architecture:** A new, self-contained `metrics.py` module (sibling to the existing `providers.py`) holds the Prometheus objects and one helper function. `main.py` wires in a request-timing middleware and the `GET /metrics` endpoint, and adds one `record_loop_tick(...)` call to each of the five named background-loop ticks' `finally` blocks — no new infrastructure, no new background loop.

**Tech Stack:** FastAPI, `prometheus-client` (new dependency), pytest against a live server (this repo's only testing convention — see `tests/conftest.py`).

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-17-prometheus-metrics-design.md`. Every task below implements one section of it.
- `GET /metrics` requires NO authentication — this was an explicit, confirmed design decision (matches Prometheus/Kubernetes convention; scrapers don't send per-target credentials).
- HTTP request metrics MUST be labeled with the matched route *template* (e.g. `/traces/{trace_id}`), never the raw requested path — labeling by raw path lets real UUIDs become distinct label values, the classic way to blow up a metrics backend's cardinality. A request that never matches a real route gets a fixed `"unmatched"` label instead of its raw path.
- `record_loop_tick(...)` fires once per loop iteration regardless of whether that iteration's inner work raised an exception (each loop already catches and logs its own inner exceptions without dying) — this metric answers "is the loop still cycling," not "did the last tick succeed."
- This repo's only testing convention is live-server integration tests over real HTTP (no mocks, no in-process TestClient) — see `tests/conftest.py`'s docstring. Do not modify `tests/conftest.py`; reuse its existing `api_headers` fixture.
- Out of scope for this plan (do not implement): OpenTelemetry integration, ingestion-time sampling, data retention/archival, LLM-provider/business metrics on `/metrics`, any frontend dashboard for these metrics.

---

### Task 1: `metrics.py` module + HTTP request instrumentation + `GET /metrics`

**Files:**
- Create: `metrics.py`
- Modify: `requirements.txt` (add `prometheus-client`)
- Modify: `main.py` — add `import time` near the top; add the middleware and endpoint right after the existing `CORSMiddleware` registration (`main.py:1110-1115`)
- Test: `tests/test_metrics.py`

**Interfaces:**
- Produces: `metrics.REQUEST_COUNT` (Counter), `metrics.REQUEST_LATENCY` (Histogram), `metrics.LOOP_LAST_RUN` (Gauge), `metrics.LOOP_TICK_DURATION` (Histogram), `metrics.record_loop_tick(loop_name: str, duration_seconds: float) -> None` — Task 2 imports and calls `record_loop_tick` by this exact name/signature.

- [ ] **Step 1: Add the dependency**

Append to `requirements.txt`:

```
prometheus-client
```

Run: `pip install prometheus-client`
Expected: installs cleanly (pure-Python package, no other dependencies to resolve).

- [ ] **Step 2: Write `metrics.py`**

```python
"""
Prometheus metrics for this app's own HTTP API and background loops — not
LLM-provider or business metrics (traces ingested, guardrail checks,
etc.), which are explicitly out of scope for this pass. See
docs/superpowers/specs/2026-08-17-prometheus-metrics-design.md.
"""

import time

from prometheus_client import Counter, Gauge, Histogram

REQUEST_COUNT = Counter(
    "http_requests_total", "Total HTTP requests", ["method", "route", "status_code"]
)
REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds", "HTTP request latency in seconds", ["method", "route"]
)

# Health of each named background-loop tick — see record_loop_tick below
# for what "a tick" means here (fires once per iteration regardless of
# whether that iteration's inner work raised).
LOOP_LAST_RUN = Gauge(
    "background_loop_last_run_timestamp_seconds",
    "Unix timestamp of the last completed tick", ["loop_name"],
)
LOOP_TICK_DURATION = Histogram(
    "background_loop_tick_duration_seconds", "Duration of one loop tick in seconds", ["loop_name"],
)


def record_loop_tick(loop_name: str, duration_seconds: float) -> None:
    LOOP_LAST_RUN.labels(loop_name=loop_name).set(time.time())
    LOOP_TICK_DURATION.labels(loop_name=loop_name).observe(duration_seconds)
```

- [ ] **Step 3: Add `import time` to `main.py`**

Near the top of `main.py`, alongside the other stdlib imports (after `import secrets` at `main.py:11`, before `import uuid` at `main.py:14`):

```python
import time
```

- [ ] **Step 4: Import the metrics module in `main.py`, and add the missing `Response` import**

`main.py` currently imports `Request` from `fastapi` (`main.py:22`) and `StreamingResponse` from `fastapi.responses` (`main.py:24`), but NOT the plain `Response` class the new endpoint needs — verify this yourself with `grep -n "^from fastapi" main.py` before assuming otherwise. Change line 22 from:

```python
from fastapi import FastAPI, Depends, Header, HTTPException, Request, BackgroundTasks
```

to:

```python
from fastapi import FastAPI, Depends, Header, HTTPException, Request, Response, BackgroundTasks
```

Then, near `main.py`'s existing `from providers import PROVIDERS, MODEL_CATALOG, estimate_cost, estimate_cost_from_total_tokens` line, add:

```python
from metrics import REQUEST_COUNT, REQUEST_LATENCY, record_loop_tick
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
```

- [ ] **Step 5: Add the middleware and endpoint**

Right after the existing CORS block in `main.py` (currently ending at line 1115 with the closing `)` of `app.add_middleware(CORSMiddleware, ...)`), add:

```python

# Request-level metrics for GET /metrics below. Route label is the matched
# route TEMPLATE (e.g. "/traces/{trace_id}"), never the raw requested path
# — labeling by raw path would let real trace/session UUIDs become
# distinct Prometheus label values, the classic way to blow up a metrics
# backend's cardinality. A request that never matches a real route (a 404
# on a made-up path) gets a fixed "unmatched" label instead of its raw
# path, so hitting random URLs can't be used to spam new label series.
@app.middleware("http")
async def prometheus_middleware(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start
    route = request.scope.get("route")
    route_label = route.path if route else "unmatched"
    REQUEST_COUNT.labels(method=request.method, route=route_label, status_code=response.status_code).inc()
    REQUEST_LATENCY.labels(method=request.method, route=route_label).observe(duration)
    return response


# GET /metrics — standard Prometheus scrape target. No auth: matches how
# every Prometheus/Kubernetes-style metrics endpoint works (scrapers don't
# send per-target credentials), and nothing exposed here carries customer
# data (route names, status codes, loop timestamps only).
@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
```

(`Request` was already imported; `Response` was added to that same import line in Step 4 above.)

- [ ] **Step 6: Write the failing test**

Create `tests/test_metrics.py`:

```python
"""
Integration tests for the Prometheus /metrics endpoint. Same live-server
convention as every other suite in this repo.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def test_metrics_endpoint_requires_no_auth_and_exposes_request_metrics(api_headers):
    # Generate at least one real, labeled request first.
    resp = requests.get(f"{BACKEND_URL}/traces", headers=api_headers)
    resp.raise_for_status()

    metrics_resp = requests.get(f"{BACKEND_URL}/metrics")  # deliberately no headers at all
    assert metrics_resp.status_code == 200
    assert metrics_resp.headers["content-type"].startswith("text/plain")
    body = metrics_resp.text
    assert "http_requests_total" in body
    assert 'route="/traces"' in body


def test_metrics_labels_unmatched_routes_not_raw_path():
    made_up_path = "/this-route-does-not-exist-12345"
    requests.get(f"{BACKEND_URL}{made_up_path}")

    metrics_resp = requests.get(f"{BACKEND_URL}/metrics")
    body = metrics_resp.text
    assert 'route="unmatched"' in body
    assert made_up_path not in body
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/test_metrics.py -v`
Expected: both tests FAIL — the server isn't running the new code yet (either `ConnectionError`/404 on `/metrics`, or the module doesn't exist yet if you run this before Step 2-5 — the point is a real failure, not a false pass).

- [ ] **Step 8: Restart the backend and run again**

Kill any process on port 8010 (Windows leaves zombie `python3.13` processes from `--reload`; always restart clean), then: `python -m uvicorn main:app --port 8010` (not `--reload`).

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/test_metrics.py -v`
Expected: both tests PASS.

- [ ] **Step 9: Commit**

```bash
git add metrics.py requirements.txt main.py tests/test_metrics.py
git commit -m "Add Prometheus /metrics endpoint with HTTP request instrumentation"
```

---

### Task 2: Background-loop health instrumentation

**Files:**
- Modify: `main.py` — `_online_scoring_loop` (`main.py:3118-3127`) and `_alert_notification_loop` (`main.py:3794-3840`)
- Test: `tests/test_metrics.py` (append)

**Interfaces:**
- Consumes: `metrics.record_loop_tick(loop_name: str, duration_seconds: float) -> None` (Task 1).

- [ ] **Step 1: Instrument `_online_scoring_loop`**

Change (main.py:3118-3127) from:

```python
async def _online_scoring_loop():
    while True:
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_online_scoring_once, db)
        except Exception as e:
            print(f"[online-scoring] loop iteration failed: {e}")
        finally:
            db.close()
        await asyncio.sleep(_ONLINE_SCORING_INTERVAL_SECONDS)
```

to:

```python
async def _online_scoring_loop():
    while True:
        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_online_scoring_once, db)
        except Exception as e:
            print(f"[online-scoring] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("online_scoring", time.perf_counter() - tick_start)
        await asyncio.sleep(_ONLINE_SCORING_INTERVAL_SECONDS)
```

- [ ] **Step 2: Instrument all four passes of `_alert_notification_loop`**

Change (main.py:3794-3840) from:

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

        # Recovery guidance runs BEFORE automation's auto-resolve: automation
        # can auto-acknowledge AND auto-resolve an incident within the same
        # tick it opens (e.g. kill_switch signals, which _incident_signal_
        # cleared always treats as already-cleared). If automation ran
        # first, that incident would resolve before recovery ever saw it —
        # the recovery query filters to status != "resolved" — and it would
        # never receive guidance at all. Running recovery first guarantees
        # even a same-tick auto-resolved incident got guidance first.
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_recovery_once, db)
        except Exception as e:
            print(f"[incident-recovery] loop iteration failed: {e}")
        finally:
            db.close()

        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_automation_once, db)
        except Exception as e:
            print(f"[incident-automation] loop iteration failed: {e}")
        finally:
            db.close()

        await asyncio.sleep(_ALERT_NOTIFICATION_INTERVAL_SECONDS)
```

to (each of the four passes gets its own `tick_start` and `record_loop_tick(...)` call in its own `finally`, tracked under its own loop_name — nothing about the passes' order, try/except structure, or comments changes otherwise):

```python
async def _alert_notification_loop():
    while True:
        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await _run_alert_notifications_once(db)
        except Exception as e:
            print(f"[alert-notifications] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("alert_notifications", time.perf_counter() - tick_start)

        # Phase 3: incident correlation/recovery/automation share this same
        # 60s tick rather than adding new background loops. Each pass opens
        # its own session and is independently try/excepted so one failing
        # pass can't block the others.
        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_correlation_once, db)
        except Exception as e:
            print(f"[incident-correlation] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("incident_correlation", time.perf_counter() - tick_start)

        # Recovery guidance runs BEFORE automation's auto-resolve: automation
        # can auto-acknowledge AND auto-resolve an incident within the same
        # tick it opens (e.g. kill_switch signals, which _incident_signal_
        # cleared always treats as already-cleared). If automation ran
        # first, that incident would resolve before recovery ever saw it —
        # the recovery query filters to status != "resolved" — and it would
        # never receive guidance at all. Running recovery first guarantees
        # even a same-tick auto-resolved incident got guidance first.
        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_recovery_once, db)
        except Exception as e:
            print(f"[incident-recovery] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("incident_recovery", time.perf_counter() - tick_start)

        tick_start = time.perf_counter()
        db = SessionLocal()
        try:
            await asyncio.to_thread(_run_incident_automation_once, db)
        except Exception as e:
            print(f"[incident-automation] loop iteration failed: {e}")
        finally:
            db.close()
            record_loop_tick("incident_automation", time.perf_counter() - tick_start)

        await asyncio.sleep(_ALERT_NOTIFICATION_INTERVAL_SECONDS)
```

- [ ] **Step 3: Write the failing test**

Append to `tests/test_metrics.py`:

```python
import time


def test_background_loop_health_metric_reflects_a_real_tick():
    deadline = time.time() + 75
    body = ""
    while time.time() < deadline:
        body = requests.get(f"{BACKEND_URL}/metrics").text
        if 'background_loop_last_run_timestamp_seconds{loop_name="online_scoring"}' in body:
            break
        time.sleep(3)

    line = next(
        (l for l in body.splitlines() if l.startswith('background_loop_last_run_timestamp_seconds{loop_name="online_scoring"}')),
        None,
    )
    assert line is not None, "online_scoring loop never reported a tick within 75s"
    reported_timestamp = float(line.split()[-1])
    # A plausible recent Unix timestamp — not zero/default, and not absurdly
    # far in the past or future — proves a REAL tick ran and instrumented
    # itself, not just that the metric name exists with a placeholder value.
    assert abs(time.time() - reported_timestamp) < 90
```

- [ ] **Step 4: Run test to verify it fails**

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/test_metrics.py::test_background_loop_health_metric_reflects_a_real_tick -v`
Expected: FAILs (either the backend isn't running the new instrumentation yet, or the metric never appears — a `None` assertion failure, not a false pass).

- [ ] **Step 5: Restart the backend and run again**

Kill any process on port 8010, restart fresh (`python -m uvicorn main:app --port 8010`, no `--reload`).

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/test_metrics.py -v`
Expected: all 3 tests in the file PASS. This one test takes up to ~75s (polling a real 60s loop tick) — let it run to completion.

- [ ] **Step 6: Commit**

```bash
git add main.py tests/test_metrics.py
git commit -m "Instrument background-loop health for Prometheus metrics"
```

---

### Task 3: Final regression pass

**Files:** none (verification only).

- [ ] **Step 1: Full clean-restart regression run**

Restart the local backend fresh (kill any zombie process on port 8010 first), confirm Postgres is up, then:

Run: `BACKEND_URL=http://localhost:8010 python -m pytest tests/ -v`
Expected: 100% pass, including all pre-existing Phase 1/2/3 tests — proves the new middleware (which now wraps every single HTTP request in this app) introduced no regression anywhere.

- [ ] **Step 2: `git status` sanity check**

Run: `git status --short`
Expected: clean — nothing left uncommitted from Tasks 1-2.

- [ ] **Step 3: Report completion**

Summarize what shipped (HTTP request metrics with route-template labeling, background-loop health for all 5 named ticks, `GET /metrics` with no auth) and that nothing has been pushed/deployed yet — matching this project's established pattern of an explicit push/deploy confirmation step before touching `origin/main` or Render.
