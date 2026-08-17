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
