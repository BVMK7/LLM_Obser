"""
Integration tests for AgentOps Phase 3 (AIOps incidents): correlating
AlertRule triggers, trace_flags, and kill-switch halts into project+
category-scoped incidents, with fingerprint dedup, an explicit state
machine, recovery guidance, and bookkeeping-only automation.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import os
import time
import uuid
from datetime import datetime, timezone

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _get(path, headers, params=None):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers, params=params or {})
    resp.raise_for_status()
    return resp.json()


def _patch(path, headers, body=None):
    resp = requests.patch(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    return resp


def _create_guardrail_incident(api_headers):
    """Shared setup: a deterministic always-fail scorer trips a guardrail
    flag, which synchronously opens a category='safety' incident — no
    background-loop wait needed, since trace_flag signals attach inline."""
    scorer = _post("/scorers", api_headers, {
        "name": f"phase3-always-fail-{uuid.uuid4().hex[:8]}",
        "prompt_template": "Respond with exactly the word: fail",
        "choice_scores": {"pass": 1.0, "fail": 0.0},
        "pass_threshold": 0.5,
    })
    trace = _post("/traces", api_headers, {"name": "phase3_guardrail_incident_test"})
    result = _post("/guardrails/check", api_headers, {
        "trace_id": trace["id"], "scorer_slug": scorer["slug"], "text": "irrelevant text",
    })
    assert result["flagged"] is True
    return trace


# --- Correlation from sync-hooked sources (fast — no loop wait) ---

def test_guardrail_flag_opens_safety_incident_with_trace_flag_signal(api_headers):
    _create_guardrail_incident(api_headers)
    incidents = _get("/incidents", api_headers, {"status": "open", "category": "safety"})
    assert len(incidents) >= 1
    matching = incidents[0]
    assert matching["category"] == "safety"
    assert matching["status"] == "open"
    assert any(s["source_type"] == "trace_flag" and "guardrail" in s["reason"] for s in matching["signals"])


def test_anomaly_and_guardrail_open_separate_incidents(api_headers):
    # Anomaly: three identical repeated tool calls, same trick Phase 2's tests use.
    anomaly_trace = _post("/traces", api_headers, {"name": "phase3_anomaly_test"})
    for _ in range(3):
        _post("/spans", api_headers, {"trace_id": anomaly_trace["id"], "step_name": "dup", "input": "same"})
    _patch(f"/traces/{anomaly_trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    _create_guardrail_incident(api_headers)

    reliability = _get("/incidents", api_headers, {"category": "reliability"})
    safety = _get("/incidents", api_headers, {"category": "safety"})
    assert len(reliability) >= 1
    assert len(safety) >= 1
    assert reliability[0]["id"] != safety[0]["id"]


def test_kill_switch_halt_creates_safety_incident_once(admin_headers, project, api_headers):
    requests.patch(
        f"{BACKEND_URL}/projects/{project['id']}", headers=admin_headers, json={"name": "phase3-killswitch", "max_session_steps": 1},
    ).raise_for_status()

    session_id = str(uuid.uuid4())
    trace = _post("/traces", api_headers, {"name": "phase3_killswitch_test", "session_id": session_id})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "s1"})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "s2"})

    # Check status three times — must not produce more than one signal (the
    # halt only fires _attach_incident_signal on the path that actually
    # creates the SessionHalt, matching the existing webhook precedent).
    for _ in range(3):
        status = _get(f"/sessions/{session_id}/status", api_headers)
    assert status["halted"] is True

    incidents = _get("/incidents", api_headers, {"category": "safety"})
    matching = next(i for i in incidents if any(s["source_type"] == "kill_switch" for s in i["signals"]))
    kill_switch_signals = [s for s in matching["signals"] if s["source_type"] == "kill_switch"]
    assert len(kill_switch_signals) == 1


# --- State machine ---

def test_state_machine_transitions_and_no_reopen(api_headers):
    trace = _create_guardrail_incident(api_headers)
    incidents = _get("/incidents", api_headers, {"status": "open", "category": "safety"})
    incident_id = incidents[0]["id"]

    ack = _patch(f"/incidents/{incident_id}", api_headers, {"status": "acknowledged"})
    assert ack.status_code == 200
    assert ack.json()["status"] == "acknowledged"

    resolved = _patch(f"/incidents/{incident_id}", api_headers, {"status": "resolved", "resolved_note": "handled"})
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "resolved"
    assert resolved.json()["resolved_note"] == "handled"

    # resolved is terminal — no transition out.
    reopen_attempt = _patch(f"/incidents/{incident_id}", api_headers, {"status": "acknowledged"})
    assert reopen_attempt.status_code == 409


def test_new_signal_after_resolution_opens_new_incident(api_headers):
    _create_guardrail_incident(api_headers)
    first = _get("/incidents", api_headers, {"status": "open", "category": "safety"})[0]
    _patch(f"/incidents/{first['id']}", api_headers, {"status": "resolved"})

    _create_guardrail_incident(api_headers)
    open_safety = _get("/incidents", api_headers, {"status": "open", "category": "safety"})
    assert len(open_safety) >= 1
    assert all(i["id"] != first["id"] for i in open_safety)


# --- Alert-rule correlation + recovery guidance (slow — up to ~70s each) ---

def test_alert_rule_trigger_creates_reliability_incident(api_headers):
    _post("/alert-rules", api_headers, {
        "name": "phase3-error-rate", "metric": "error_rate", "comparator": ">", "threshold": 0.0, "window_minutes": 60,
    })
    trace = _post("/traces", api_headers, {"name": "phase3_alert_trigger_test"})
    _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "s1", "error": "boom"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": None, "ended_at": _now_iso()})

    deadline = time.time() + 75
    incidents = []
    while time.time() < deadline:
        incidents = _get("/incidents", api_headers, {"category": "reliability"})
        if any(any(s["source_type"] == "alert_rule" for s in i["signals"]) for i in incidents):
            break
        time.sleep(3)

    matching = next(i for i in incidents if any(s["source_type"] == "alert_rule" for s in i["signals"]))
    assert matching["category"] == "reliability"


def test_recovery_guidance_populated_within_one_loop_tick(api_headers):
    _create_guardrail_incident(api_headers)
    incident_id = _get("/incidents", api_headers, {"status": "open", "category": "safety"})[0]["id"]

    deadline = time.time() + 75
    detail = None
    while time.time() < deadline:
        detail = _get(f"/incidents/{incident_id}", api_headers)
        if detail["recovery_suggestion"] is not None:
            break
        time.sleep(3)

    assert detail["recovery_suggestion"] is not None
    assert not detail["recovery_suggestion"].startswith("(Couldn't generate")
    assert detail["recovery_suggestion_json"] is not None
    assert set(detail["recovery_suggestion_json"].keys()) == {"likely_cause", "suggested_actions", "confidence"}
    assert detail["recovery_suggestion_json"]["confidence"] in ("low", "medium", "high")


# --- Automation mode (bookkeeping only) ---

def test_automation_mode_auto_acknowledges_and_auto_resolves(admin_headers, project, api_headers):
    requests.patch(
        f"{BACKEND_URL}/projects/{project['id']}", headers=admin_headers,
        json={"name": "phase3-automation", "incident_automation_enabled": True},
    ).raise_for_status()

    scorer = _post("/scorers", api_headers, {
        "name": f"phase3-automation-fail-{uuid.uuid4().hex[:8]}",
        "prompt_template": "Respond with exactly the word: fail",
        "choice_scores": {"pass": 1.0, "fail": 0.0},
        "pass_threshold": 0.5,
    })
    trace = _post("/traces", api_headers, {"name": "phase3_automation_test"})
    _post("/guardrails/check", api_headers, {"trace_id": trace["id"], "scorer_slug": scorer["slug"], "text": "x"})

    # Auto-acknowledge happens synchronously at creation — no loop wait.
    incident = _get("/incidents", api_headers, {"category": "safety"})[0]
    assert incident["status"] == "acknowledged"
    flag_id = incident["signals"][0]["source_id"]

    # Resolve the underlying trace_flag directly — this is what "clears" a
    # trace_flag signal for the auto-resolve check.
    requests.patch(f"{BACKEND_URL}/traces/{trace['id']}/flags/{flag_id}", headers=api_headers, json={}).raise_for_status()

    deadline = time.time() + 75
    final_status = None
    while time.time() < deadline:
        final_status = _get(f"/incidents/{incident['id']}", api_headers)["status"]
        if final_status == "resolved":
            break
        time.sleep(3)

    assert final_status == "resolved"
