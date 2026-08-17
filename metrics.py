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
    "http_request_duration_seconds", "HTTP request latency in seconds", ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0, float("inf")),
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
