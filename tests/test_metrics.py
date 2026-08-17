"""
Integration tests for the Prometheus /metrics endpoint. Same live-server
convention as every other suite in this repo.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os
import time

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
