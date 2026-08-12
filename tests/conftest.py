"""
Shared pytest fixtures for the backend's integration tests.

These tests hit a REAL, already-running backend + Postgres over real HTTP —
the same convention every other verification in this repo uses
(test_error_explanation.py, score_trace.py, scripts/run_eval_gate.py), just
with real `assert` statements instead of print statements for a human to
read. There's no in-process FastAPI TestClient and no separate test
database: start the backend yourself (`python -m uvicorn main:app --port
8010`, with Postgres up and migrations applied) before running `pytest`.

Login uses this app's real signup/login endpoint. Per an explicit product
decision (see main.py's `login`), that endpoint is an intentional open gate:
ANY email/password logs in, auto-signing-up an unknown email on the spot —
so a random per-run email is all `admin_headers` needs, no fixture seeding.
"""

import os
import uuid

import pytest
import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


@pytest.fixture(scope="session")
def admin_headers():
    """A logged-in human session (Bearer token) — used only for project
    management (POST/DELETE /projects), never for data-plane calls."""
    email = f"pytest-{uuid.uuid4()}@nowhere.test"
    resp = requests.post(f"{BACKEND_URL}/auth/login", json={"email": email, "password": "pytest"})
    resp.raise_for_status()
    token = resp.json()["session_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def project(admin_headers):
    """A fresh, empty project (and its API key) for one test — created
    before the test runs, deleted (cascading to everything under it) after,
    so tests never see another test's leftover data."""
    resp = requests.post(
        f"{BACKEND_URL}/projects", headers=admin_headers, json={"name": f"pytest-{uuid.uuid4()}"}
    )
    resp.raise_for_status()
    data = resp.json()
    yield {"id": data["id"], "api_key": data["api_key"]}
    requests.delete(f"{BACKEND_URL}/projects/{data['id']}", headers=admin_headers)


@pytest.fixture
def api_headers(project):
    """The X-API-Key header for `project` — what every data-plane call
    (traces, agents, memory, messages, sessions) authenticates with."""
    return {"X-API-Key": project["api_key"], "Content-Type": "application/json"}
