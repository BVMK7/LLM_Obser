"""
Integration tests for the Prometheus /metrics endpoint. Same live-server
convention as every other suite in this repo.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os
import time
import uuid

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


_ALL_LOOP_NAMES = (
    "online_scoring",
    "alert_notifications",
    "incident_correlation",
    "incident_recovery",
    "incident_automation",
)


def test_background_loop_health_metric_reflects_a_real_tick():
    # Poll for ALL five named loops, not just one — a typo in any of the
    # other four `record_loop_tick(...)` call sites would ship green if
    # only "online_scoring" were checked here.
    deadline = time.time() + 75
    body = ""
    seen = set()
    while time.time() < deadline and len(seen) < len(_ALL_LOOP_NAMES):
        body = requests.get(f"{BACKEND_URL}/metrics").text
        seen = {
            name for name in _ALL_LOOP_NAMES
            if f'background_loop_last_run_timestamp_seconds{{loop_name="{name}"}}' in body
        }
        if len(seen) < len(_ALL_LOOP_NAMES):
            time.sleep(3)

    for name in _ALL_LOOP_NAMES:
        line = next(
            (l for l in body.splitlines() if l.startswith(f'background_loop_last_run_timestamp_seconds{{loop_name="{name}"}}')),
            None,
        )
        assert line is not None, f"{name} loop never reported a tick within 75s"
        reported_timestamp = float(line.split()[-1])
        # A plausible recent Unix timestamp — not zero/default, and not
        # absurdly far in the past or future — proves a REAL tick ran and
        # instrumented itself, not just that the metric name exists with a
        # placeholder value.
        assert abs(time.time() - reported_timestamp) < 90, f"{name} loop's last-run timestamp is not recent"


def test_stream_disconnect_leaves_server_healthy(api_headers):
    # Regression guard for the BaseHTTPMiddleware -> pure-ASGI-middleware
    # fix: the old middleware silently broke Request.is_disconnected() for
    # EVERY endpoint, including this pre-existing SSE stream, so an
    # abandoned browser tab held its DB session open for the full 10-minute
    # cap instead of noticing the disconnect within a couple of seconds.
    #
    # This is a black-box HTTP test with no access to server internals, so
    # it can't directly observe the server-side generator stopping early.
    # What it DOES verify: opening the stream, reading a live frame, then
    # disconnecting abruptly mid-stream doesn't leave the server wedged or
    # crashed — a fresh, unrelated request right after still succeeds
    # promptly. That's a real (if weaker) regression guard against the fix
    # breaking something outright.
    session_id = str(uuid.uuid4())
    trace_resp = requests.post(
        f"{BACKEND_URL}/traces", headers=api_headers,
        json={"name": "metrics_stream_disconnect_test", "session_id": session_id},
    )
    trace_resp.raise_for_status()
    trace_id = trace_resp.json()["id"]
    span_resp = requests.post(
        f"{BACKEND_URL}/spans", headers=api_headers,
        json={"trace_id": trace_id, "step_name": "s1"},
    )
    span_resp.raise_for_status()

    stream_resp = requests.get(
        f"{BACKEND_URL}/sessions/{session_id}/stream", headers=api_headers, stream=True, timeout=30,
    )
    stream_resp.raise_for_status()
    first_chunk = next(stream_resp.iter_content(chunk_size=None))
    assert first_chunk  # the stream is live — got at least one SSE frame
    stream_resp.close()  # abrupt client-side disconnect, mid-stream

    docs_resp = requests.get(f"{BACKEND_URL}/docs", timeout=5)
    assert docs_resp.status_code == 200
