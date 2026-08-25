"""
Integration tests for OpenTelemetry export. Traces/spans/settings go
through the real API; the export loop itself (which only ticks once per
60s in the running server) is invoked directly rather than waited for —
same deliberate, narrow exception to this repo's live-server-HTTP-only
testing convention as tests/test_retention.py's _run_retention_sweep_once.

The "collector" side is a tiny local HTTP server (stdlib http.server) run
on a background thread for the duration of each test — a real OTel
collector is always an external HTTP receiver this app POSTs *to*, so a
local stand-in is the only way to capture and assert on the payload shape
without depending on any real collector being reachable.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests
from sqlalchemy import text

from main import SessionLocal, _run_otel_export_once

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _patch(path, headers, body=None):
    resp = requests.patch(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _set_otel_collector_url(admin_headers, project_id, url):
    requests.patch(
        f"{BACKEND_URL}/projects/{project_id}", headers=admin_headers,
        json={"name": "otel-export-test", "otel_collector_url": url},
    ).raise_for_status()


def _exported_at(trace_id):
    db = SessionLocal()
    try:
        return db.execute(
            text("SELECT otel_exported_at FROM traces WHERE id = :id"),
            {"id": str(trace_id)},
        ).scalar()
    finally:
        db.close()


class _MockCollector:
    """A minimal local stand-in for an OTLP/HTTP collector — captures every
    POSTed JSON body so a test can assert on its shape, and always answers
    200 OK so _send_otel_export's raise_for_status() never trips."""

    def __init__(self):
        self.received = []
        received = self.received

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                received.append(json.loads(body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, fmt, *args):
                pass  # silence default per-request stderr logging

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self):
        host, port = self._server.server_address
        return f"http://{host}:{port}/v1/traces"

    def shutdown(self):
        self._server.shutdown()
        self._thread.join(timeout=5)


@pytest.fixture
def mock_collector():
    collector = _MockCollector()
    yield collector
    collector.shutdown()


def test_completed_trace_gets_exported_and_marked(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)

    trace = _post("/traces", api_headers, {"name": "otel_trace", "model": "gpt-x", "total_tokens": 42, "cost": 0.01})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "llm_call", "input": "hi", "output": "hello"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert len(mock_collector.received) == 1
    payload = mock_collector.received[0]
    resource_attrs = payload["resourceSpans"][0]["resource"]["attributes"]
    service_name_attr = next(a for a in resource_attrs if a["key"] == "service.name")
    assert isinstance(service_name_attr["value"]["stringValue"], str) and service_name_attr["value"]["stringValue"]

    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    assert len(spans) == 2  # root (trace) + 1 child (span)

    trace_id_hex = uuid.UUID(trace["id"]).hex
    root = next(s for s in spans if "parentSpanId" not in s)
    child = next(s for s in spans if "parentSpanId" in s)
    assert root["traceId"] == trace_id_hex
    assert root["spanId"] == trace_id_hex[:16]
    assert child["parentSpanId"] == trace_id_hex[:16]
    attr_keys = {a["key"] for a in root["attributes"]}
    assert {"model", "total_tokens", "cost"} <= attr_keys

    assert _exported_at(trace["id"]) is not None


def test_span_error_maps_to_error_status(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)

    trace = _post("/traces", api_headers, {"name": "otel_error_trace"})
    span = _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "risky_call"})
    _patch(f"/spans/{span['id']}", api_headers, {"error": "boom", "ended_at": _now_iso()})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    payload = mock_collector.received[0]
    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    errored = next(s for s in spans if "parentSpanId" in s)
    assert errored["status"]["code"] == "STATUS_CODE_ERROR"


def test_trace_is_not_reexported_on_a_second_tick(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)
    trace = _post("/traces", api_headers, {"name": "otel_once_trace"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
        _run_otel_export_once(db)
    finally:
        db.close()

    assert len(mock_collector.received) == 1


def test_no_collector_url_never_exports(admin_headers, project, api_headers, mock_collector):
    # project fixture's default has otel_collector_url unset (NULL) — never
    # pointed at mock_collector at all, so any POST here would be a bug.
    trace = _post("/traces", api_headers, {"name": "otel_disabled_trace"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert mock_collector.received == []
    assert _exported_at(trace["id"]) is None


def test_pending_trace_is_not_exported(admin_headers, project, api_headers, mock_collector):
    _set_otel_collector_url(admin_headers, project["id"], mock_collector.url)
    trace = _post("/traces", api_headers, {"name": "otel_pending_trace"})
    # Deliberately never PATCHed with ended_at — stays "pending".

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert mock_collector.received == []
    assert _exported_at(trace["id"]) is None


def test_collector_failure_leaves_trace_unexported_for_retry(admin_headers, project, api_headers):
    # Point at a port nothing is listening on — the POST fails, so
    # otel_exported_at must stay NULL, letting the next tick retry forever
    # (no backoff, per the approved design).
    _set_otel_collector_url(admin_headers, project["id"], "http://127.0.0.1:1/nowhere")
    trace = _post("/traces", api_headers, {"name": "otel_unreachable_trace"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_otel_export_once(db)
    finally:
        db.close()

    assert _exported_at(trace["id"]) is None
