"""
Integration tests for AgentOps Phase 2 (Operational): async trace
ingestion + failure classification, the real review-queue (trace_flags),
and the advisory policy engine.

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

_FAILURE_CATEGORIES = {"rate_limit", "timeout", "auth_error", "validation_error", "tool_error", "context_length", "unknown"}


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
    resp.raise_for_status()
    return resp.json()


# --- Async ingestion + failure classification ---

def test_span_error_returns_immediately_then_classified_in_background(api_headers):
    trace = _post("/traces", api_headers, {"name": "async_ingestion_test"})
    span = _post("/spans", api_headers, {
        "trace_id": trace["id"], "step_name": "flaky_call", "error": "ConnectionError: 429 Too Many Requests",
    })
    # Returns immediately — the Groq explain/classify call hasn't run yet.
    assert span["error_explanation"] is None
    assert span["failure_category"] is None

    deadline = time.time() + 20
    updated_trace = None
    while time.time() < deadline:
        updated_trace = _get(f"/traces/{trace['id']}", api_headers)
        matching_span = next(s for s in updated_trace["spans"] if s["id"] == span["id"])
        if matching_span["error_explanation"] is not None:
            break
        time.sleep(1)

    assert matching_span["error_explanation"] is not None
    assert matching_span["failure_category"] in _FAILURE_CATEGORIES


def test_span_update_error_also_classified_async(api_headers):
    trace = _post("/traces", api_headers, {"name": "async_ingestion_update_test"})
    span = _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "call"})
    updated = _patch(f"/spans/{span['id']}", api_headers, {"error": "TimeoutError: request timed out after 30s"})
    assert updated["error_explanation"] is None

    deadline = time.time() + 20
    final = None
    while time.time() < deadline:
        final = _get(f"/traces/{trace['id']}", api_headers)
        matching_span = next(s for s in final["spans"] if s["id"] == span["id"])
        if matching_span["error_explanation"] is not None:
            break
        time.sleep(1)
    assert matching_span["failure_category"] in _FAILURE_CATEGORIES


# --- Review queue (trace_flags) ---

def test_anomaly_flag_appears_in_flagged_list(api_headers):
    trace = _post("/traces", api_headers, {"name": "anomaly_flag_test"})
    for _ in range(3):
        _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "dup_step", "input": "same input"})
    finished = _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})
    assert finished["flagged_for_review"] is True

    flagged = _get("/traces/flagged", api_headers)
    matching = next(t for t in flagged if t["id"] == trace["id"])
    assert any(f["source"] == "anomaly" and f["resolved_at"] is None for f in matching["flags"])


def test_resolve_all_via_legacy_flag_endpoint(api_headers):
    trace = _post("/traces", api_headers, {"name": "legacy_resolve_test"})
    for _ in range(3):
        _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "dup", "input": "x"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    flagged_ids = [t["id"] for t in _get("/traces/flagged", api_headers)]
    assert trace["id"] in flagged_ids

    resolved = _patch(f"/traces/{trace['id']}/flag", api_headers, {"flagged_for_review": False})
    assert resolved["flagged_for_review"] is False
    assert resolved["review_note"] is None

    flagged_ids_after = [t["id"] for t in _get("/traces/flagged", api_headers)]
    assert trace["id"] not in flagged_ids_after


def test_guardrail_flag_source_and_independent_resolution(api_headers):
    # A deterministic scorer (not real prompt-injection judgment, which is
    # inherently non-deterministic across calls) so this test never flakes.
    scorer = _post("/scorers", api_headers, {
        "name": f"always-fail-{uuid.uuid4().hex[:8]}",
        "prompt_template": "Respond with exactly the word: fail",
        "choice_scores": {"pass": 1.0, "fail": 0.0},
        "pass_threshold": 0.5,
    })

    trace = _post("/traces", api_headers, {"name": "guardrail_flag_test"})
    result = _post("/guardrails/check", api_headers, {
        "trace_id": trace["id"], "scorer_slug": scorer["slug"], "text": "irrelevant text",
    })
    assert result["flagged"] is True

    flagged = _get("/traces/flagged", api_headers)
    matching = next(t for t in flagged if t["id"] == trace["id"])
    guardrail_flags = [f for f in matching["flags"] if f["source"] == "guardrail"]
    assert len(guardrail_flags) == 1

    # Also trigger an anomaly flag on the SAME trace, then resolve only the
    # guardrail flag — the trace must stay flagged because the anomaly flag
    # is still open (this is the whole point of per-flag resolution).
    for _ in range(3):
        _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "dup", "input": "y"})
    _patch(f"/traces/{trace['id']}", api_headers, {"output": "done", "ended_at": _now_iso()})

    still_flagged = _get(f"/traces/{trace['id']}", api_headers)
    assert still_flagged["flagged_for_review"] is True

    guardrail_flag_id = guardrail_flags[0]["id"]
    _patch(f"/traces/{trace['id']}/flags/{guardrail_flag_id}", api_headers, {"resolved_note": "false positive"})

    after_partial_resolve = _get(f"/traces/{trace['id']}", api_headers)
    assert after_partial_resolve["flagged_for_review"] is True  # anomaly flag still open

    flagged_after = _get("/traces/flagged", api_headers)
    matching_after = next(t for t in flagged_after if t["id"] == trace["id"])
    open_sources = {f["source"] for f in matching_after["flags"] if f["resolved_at"] is None}
    assert open_sources == {"anomaly"}


# --- Policy engine (advisory) ---

def test_policy_blocked_model(api_headers):
    _post("/policies", api_headers, {
        "name": "no-gpt4",
        "rule_type": "blocked_model",
        "config": {"models": ["gpt-4"]},
    })

    blocked = _post("/policies/check", api_headers, {"model": "gpt-4"})
    assert blocked["allowed"] is False
    assert any("gpt-4" in v for v in blocked["violations"])

    allowed = _post("/policies/check", api_headers, {"model": "llama-3.1-8b-instant"})
    assert allowed["allowed"] is True
    assert allowed["violations"] == []


def test_policy_max_cost_per_call(api_headers):
    _post("/policies", api_headers, {
        "name": "cost-cap",
        "rule_type": "max_cost_per_call",
        "config": {"max_cost": 0.10},
    })

    over = _post("/policies/check", api_headers, {"estimated_cost": 0.50})
    assert over["allowed"] is False

    under = _post("/policies/check", api_headers, {"estimated_cost": 0.01})
    assert under["allowed"] is True


def test_policy_disabled_rule_not_enforced(api_headers):
    policy = _post("/policies", api_headers, {
        "name": "disabled-block",
        "rule_type": "blocked_tool",
        "config": {"tools": ["shell_exec"]},
        "enabled": False,
    })
    assert policy["enabled"] is False

    result = _post("/policies/check", api_headers, {"tool_name": "shell_exec"})
    assert result["allowed"] is True
