# Prometheus Metrics Endpoint — Design

## Context

This is the first of four independent sub-projects originally bundled
under "Phase 4: Scalability/OTel/Prometheus" in the platform's roadmap —
OpenTelemetry integration, ingestion-time sampling, and data retention are
each their own scope and are deliberately NOT covered here (see "Explicitly
out of scope" below).

This app has zero request-level or background-loop observability into
itself today. `main.py` already runs several always-on async background
loops (`_online_scoring_loop`; `_alert_notification_loop`, which since
Phase 3 fans out into four sequential passes — notifications, incident
correlation, incident automation, incident recovery — each independently
try/excepted so one failing pass can't take down the others), but nothing
external can tell whether any of them are actually still ticking, or how
the HTTP API itself is performing. This adds a standard `GET /metrics`
endpoint so real monitoring (Grafana, Datadog, Prometheus itself) can be
pointed at this app.

## Scope decisions (confirmed with the user)

- **Coverage**: HTTP request metrics + background-loop health only — no
  LLM-provider/business metrics (traces ingested, guardrail checks, etc.)
  in this pass. Those can be a follow-up if this proves useful.
- **Auth**: `GET /metrics` requires no authentication, matching how every
  Prometheus/Kubernetes-style metrics endpoint works — scrapers don't send
  per-target credentials, and the metrics themselves (route names, status
  codes, loop timestamps) carry no customer data.

## Module structure

New file `metrics.py`, sitting alongside the existing `providers.py` (both
are focused, single-purpose modules `main.py` imports from — this app's
established pattern for anything that isn't itself a FastAPI route or
SQLAlchemy model). `main.py` is already large; a self-contained metrics
registry is a clean, independently-testable unit that doesn't need to live
inside it.

`metrics.py` exports:

```python
from prometheus_client import Counter, Histogram, Gauge

REQUEST_COUNT = Counter(
    "http_requests_total", "Total HTTP requests", ["method", "route", "status_code"]
)
REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds", "HTTP request latency in seconds", ["method", "route"]
)
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

(`time` imported inside `metrics.py`; `main.py` never touches these
objects directly except via `record_loop_tick` and the two HTTP-metrics
objects in its middleware.)

## HTTP request instrumentation

A FastAPI `@app.middleware("http")` function in `main.py`, added near the
existing `CORSMiddleware` registration:

```python
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
```

The route-template label (`route.path`, e.g. `/traces/{trace_id}`, not the
literal requested path) is the load-bearing detail here — labeling by raw
path would let real trace/session UUIDs become distinct Prometheus label
values, which is the classic way to blow up a metrics backend's
cardinality. Any request that never matches a real route (a 404 on a
made-up path) is labeled `"unmatched"` instead of the raw path, so hitting
random URLs can't be used to spam new label series either.

## Background-loop instrumentation

Each of the five named ticks gets wrapped with a start time, its existing
work, then a call to `record_loop_tick(name, duration)` in that tick's
`finally` block — so it fires once per iteration regardless of whether the
tick's inner work raised (each loop already catches and logs its own inner
exceptions without dying, per existing precedent). The question this
metric answers is "is this loop still cycling at all," not "did its last
tick's business logic succeed" — a loop that's silently crashed and
stopped iterating entirely is the failure mode worth alerting on; a single
bad tick that logged an error and kept going is not what
`background_loop_last_run_timestamp_seconds` is for. Named ticks:

- `_online_scoring_loop` → `"online_scoring"`
- `_alert_notification_loop`'s four passes → `"alert_notifications"`,
  `"incident_correlation"`, `"incident_automation"`, `"incident_recovery"`

Tracking each of the four passes separately (rather than the whole loop
tick as one blob) is the point: since Phase 3, these are four genuinely
independent pieces of work in the same loop, each already isolated by its
own try/except — a hang or silent failure in just `incident_recovery`
(e.g. Groq going slow) should be individually diagnosable rather than
masked by the other three still succeeding on schedule.

## Endpoint

```python
from fastapi import Response
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST

@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
```

No `Depends(...)` — genuinely open, per the auth decision above.

## Dependency

Add `prometheus-client` to `requirements.txt`.

## Explicitly out of scope for this turn

- OpenTelemetry integration (export/ingest) — its own, larger sub-project
  with a real design fork (export this app's traces as OTel spans for
  external tools, vs. ingest OTel-instrumented external apps' traces) that
  needs its own brainstorming pass.
- Ingestion-time sampling — deferred; not useful yet without a real
  high-volume production load to protect against.
- Data retention/archival — its own sub-project; touches the data model
  and needs careful default choices so nothing disappears by surprise.
- LLM-provider/business metrics (traces ingested, guardrail checks,
  incidents opened, etc.) on `/metrics` — explicitly deferred per the
  scope decision above; can follow up once basic HTTP/loop health proves
  useful.
- Any dashboard/UI for these metrics — this endpoint is for external
  monitoring tools to scrape, not a page in this app's own frontend.

## Testing plan

New `tests/test_metrics.py`, same live-server convention as every other
suite in this repo:

- Hit a couple of existing endpoints (e.g. `GET /traces`, `POST /traces`)
  via the standard `api_headers` fixture, then `GET /metrics` (no auth
  header at all) and confirm: `200` status, content-type starts with
  `text/plain`, and the body contains a `http_requests_total` line with a
  `route="/traces"` label (proving the route-template labeling, not a raw
  path, is what's actually emitted).
- Hit a nonexistent path (`GET /this-route-does-not-exist`), confirm the
  metrics body contains a `route="unmatched"` label rather than the literal
  path string.
- Poll `GET /metrics` (up to ~70s, matching this repo's established
  background-loop-polling pattern from the Phase 2/3 test suites) for
  `background_loop_last_run_timestamp_seconds{loop_name="online_scoring"}`
  to appear with a value that's a plausible recent Unix timestamp — proving
  a real loop tick actually ran and instrumented itself, not just that the
  metric name exists with a zero/default value.
