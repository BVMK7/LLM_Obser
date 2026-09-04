"""
API contract snapshot tests -- a regression safety net proving today's
exact JSON response shapes for this app's core resources, independent of
FastAPI's own response_model validation (which enforces shape at the type
level but wouldn't catch a field silently renamed on both the request and
response side of a future refactor). Each test asserts the COMPLETE key
set of a real response, not a subset -- adding, removing, or renaming a
field breaks the test immediately.

Purely additive: no existing application code changes. Run against a
local backend + Postgres already up and migrated, same convention as
every other test in this repo:
    pytest tests/test_api_contract.py -v
"""

import os
import uuid

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _get(path, headers):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers)
    resp.raise_for_status()
    return resp.json()


TRACE_KEYS = {
    "id", "name", "input", "output", "started_at", "ended_at", "total_tokens",
    "cost", "model", "session_id", "status", "flagged_for_review", "agent_id",
    "review_note",
}


def test_trace_contract(api_headers):
    trace = _post("/traces", api_headers, {"name": "pytest-contract-trace"})
    assert set(trace.keys()) == TRACE_KEYS


SPAN_KEYS = {
    "id", "trace_id", "step_name", "input", "output", "error", "parent_span_id",
    "started_at", "error_explanation", "failure_category",
}


def test_span_contract(api_headers):
    trace = _post("/traces", api_headers, {"name": "pytest-contract-trace-for-span"})
    span = _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "pytest-step"})
    assert set(span.keys()) == SPAN_KEYS


SCORE_KEYS = {"id", "trace_id", "span_id", "score_name", "score_value", "explanation", "created_at"}


def test_score_contract(api_headers):
    trace = _post("/traces", api_headers, {"name": "pytest-contract-trace-for-score"})
    score = _post("/scores", api_headers, {
        "trace_id": trace["id"], "score_name": "pytest-score", "score_value": 1.0,
    })
    assert set(score.keys()) == SCORE_KEYS


PROJECT_CREATE_KEYS = {
    "id", "name", "created_at", "max_session_steps", "max_session_cost",
    "max_session_seconds", "kill_switch_webhook_url", "incident_webhook_url",
    "incident_automation_enabled", "retention_days", "otel_collector_url", "api_key",
}


def test_project_contract(admin_headers):
    created = _post("/projects", admin_headers, {"name": f"pytest-contract-project-{uuid.uuid4()}"})
    try:
        assert set(created.keys()) == PROJECT_CREATE_KEYS
    finally:
        requests.delete(f"{BACKEND_URL}/projects/{created['id']}", headers=admin_headers)


AGENT_KEYS = {"id", "name", "slug", "description", "created_at"}


def test_agent_contract(api_headers):
    _post("/traces", api_headers, {"name": "pytest-contract-agent-trace", "agent_name": "pytest-contract-agent"})
    agents = _get("/agents", api_headers)
    assert len(agents) >= 1
    assert set(agents[0].keys()) == AGENT_KEYS


ALERT_RULE_KEYS = {
    "id", "name", "metric", "comparator", "threshold", "window_minutes",
    "enabled", "webhook_url", "created_at",
}


def test_alert_rule_contract(api_headers):
    rule = _post("/alert-rules", api_headers, {
        "name": "pytest-contract-rule", "metric": "error_rate", "comparator": ">", "threshold": 0.5,
    })
    assert set(rule.keys()) == ALERT_RULE_KEYS


POLICY_RULE_KEYS = {"id", "name", "rule_type", "config", "enabled", "created_at"}


def test_policy_rule_contract(api_headers):
    policy = _post("/policies", api_headers, {
        "name": "pytest-contract-policy", "rule_type": "max_cost_per_call", "config": {"max_cost": 1.0},
    })
    assert set(policy.keys()) == POLICY_RULE_KEYS


SCORER_KEYS = {
    "id", "name", "description", "scorer_type", "prompt_template", "choice_scores",
    "pattern", "pattern_is_regex", "pass_threshold", "run_online", "slug",
    "created_at", "updated_at",
}


def test_scorer_contract(api_headers):
    scorer = _post("/scorers", api_headers, {
        "name": "pytest-contract-scorer", "scorer_type": "pattern_match", "pattern": "MATCHTHIS",
    })
    assert set(scorer.keys()) == SCORER_KEYS


DATASET_KEYS = {"id", "name", "description", "cases", "created_at", "updated_at"}


def test_dataset_contract(api_headers):
    dataset = _post("/datasets", api_headers, {"name": "pytest-contract-dataset"})
    assert set(dataset.keys()) == DATASET_KEYS


PROMPT_KEYS = {"id", "name", "category", "content", "tags", "usage_count", "created_at", "updated_at"}


def test_prompt_contract(api_headers):
    prompt = _post("/prompts", api_headers, {
        "name": "pytest-contract-prompt", "content": "You are a helpful assistant.",
    })
    assert set(prompt.keys()) == PROMPT_KEYS


EXPERIMENT_KEYS = {
    "id", "name", "description", "dataset_id", "providers", "scorer_slugs",
    "created_at", "results",
}
EXPERIMENT_RESULT_KEYS = {
    "id", "experiment_id", "question", "expected", "provider", "model", "answer",
    "passed", "scores", "input_tokens", "output_tokens", "total_tokens", "cost",
    "latency_ms", "trace_id", "created_at", "human_verdict", "reviewed_at",
}


def test_experiment_contract(api_headers):
    experiment = _post("/experiments", api_headers, {
        "name": "pytest-contract-experiment",
        "results": [{"question": "q", "provider": "groq", "answer": "a", "passed": True}],
    })
    assert set(experiment.keys()) == EXPERIMENT_KEYS
    assert len(experiment["results"]) == 1
    assert set(experiment["results"][0].keys()) == EXPERIMENT_RESULT_KEYS


INCIDENT_KEYS = {
    "id", "project_id", "category", "status", "severity", "opened_at",
    "acknowledged_at", "resolved_at", "resolved_note", "recovery_suggestion",
    "recovery_suggestion_json", "signals",
}


def test_incident_contract(api_headers):
    # A pattern_match guardrail that DOESN'T match the given text scores 0.0,
    # below the default 0.5 pass_threshold -> flagged=True -> a "guardrail"
    # trace_flag -> correlated into a new "safety" incident, synchronously
    # within this same request (see check_guardrail/_create_trace_flag).
    scorer = _post("/scorers", api_headers, {
        "name": "pytest-contract-incident-scorer", "scorer_type": "pattern_match", "pattern": "MATCHTHIS",
    })
    trace = _post("/traces", api_headers, {"name": "pytest-contract-incident-trace"})
    check = _post("/guardrails/check", api_headers, {
        "trace_id": trace["id"], "scorer_slug": scorer["slug"], "text": "this text does not contain the target",
    })
    assert check["flagged"] is True  # sanity check the trigger actually worked

    incidents = _get("/incidents", api_headers)
    assert len(incidents) >= 1
    assert set(incidents[0].keys()) == INCIDENT_KEYS
