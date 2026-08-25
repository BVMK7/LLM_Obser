"""
Integration tests for data retention & archival. Traces/settings go
through the real API; the sweep itself (which only ticks once per 24h in
the running server) is invoked directly rather than waited for — see the
plan's Task 5 note for why this is a deliberate, narrow exception to this
repo's live-server-HTTP-only testing convention.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import requests
from sqlalchemy import text

from main import SessionLocal, _run_retention_sweep_once

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _iso(dt):
    return dt.isoformat()


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _patch(path, headers, body=None):
    return requests.patch(f"{BACKEND_URL}{path}", headers=headers, json=body or {})


def _get(path, headers):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers)
    resp.raise_for_status()
    return resp.json()


def _set_retention(admin_headers, project_id, days):
    requests.patch(
        f"{BACKEND_URL}/projects/{project_id}", headers=admin_headers,
        json={"name": "retention-test", "retention_days": days},
    ).raise_for_status()


def _archived_row(trace_id):
    db = SessionLocal()
    try:
        return db.execute(
            text("SELECT project_id, data FROM archived_traces WHERE id = :id"),
            {"id": str(trace_id)},
        ).fetchone()
    finally:
        db.close()


def test_old_completed_trace_gets_archived_and_deleted(admin_headers, project, api_headers):
    _set_retention(admin_headers, project["id"], 1)

    old_started = datetime.now(timezone.utc) - timedelta(days=5)
    trace = _post("/traces", api_headers, {"name": "old_trace", "started_at": _iso(old_started)})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    missing = requests.get(f"{BACKEND_URL}/traces/{trace['id']}", headers=api_headers)
    assert missing.status_code == 404

    row = _archived_row(trace["id"])
    assert row is not None
    assert str(row.project_id) == project["id"]
    assert row.data["name"] == "old_trace"


def test_trace_with_open_flag_is_not_archived(admin_headers, project, api_headers):
    _set_retention(admin_headers, project["id"], 1)

    old_started = datetime.now(timezone.utc) - timedelta(days=5)
    trace = _post("/traces", api_headers, {"name": "flagged_old_trace", "started_at": _iso(old_started)})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})
    _patch(f"/traces/{trace['id']}/flag", api_headers, {"flagged_for_review": True, "review_note": "still needs a look"})

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    still_there = _get(f"/traces/{trace['id']}", api_headers)
    assert still_there["id"] == trace["id"]
    assert _archived_row(trace["id"]) is None


def test_pending_trace_is_not_archived(admin_headers, project, api_headers):
    _set_retention(admin_headers, project["id"], 1)

    old_started = datetime.now(timezone.utc) - timedelta(days=5)
    trace = _post("/traces", api_headers, {"name": "pending_old_trace", "started_at": _iso(old_started)})
    # Deliberately never PATCHed with ended_at — stays "pending".

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    still_there = _get(f"/traces/{trace['id']}", api_headers)
    assert still_there["id"] == trace["id"]
    assert _archived_row(trace["id"]) is None


def test_no_retention_set_never_archives(admin_headers, project, api_headers):
    # project fixture's default has retention_days unset (NULL).
    old_started = datetime.now(timezone.utc) - timedelta(days=365)
    trace = _post("/traces", api_headers, {"name": "ancient_trace", "started_at": _iso(old_started)})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    db = SessionLocal()
    try:
        _run_retention_sweep_once(db)
    finally:
        db.close()

    still_there = _get(f"/traces/{trace['id']}", api_headers)
    assert still_there["id"] == trace["id"]
    assert _archived_row(trace["id"]) is None
