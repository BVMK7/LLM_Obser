"""
Regression coverage for PATCH /experiments/{experiment_id}/results/{result_id}/review.

Human-in-the-loop calibration signal: a reviewer marks whether they agree
with an automated experiment result's pass/fail verdict. `human_verdict` and
`reviewed_at` start out NULL/unset and are additive only — reviewing a
result must never touch its `passed`/`scores` fields. Ownership is checked
the same way `resolve_trace_flag` checks trace/flag ownership: the result
must belong to the experiment named in the URL, or it's a 404.
"""

import os
import uuid
from datetime import datetime

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _create_experiment_with_results(api_headers):
    create_resp = requests.post(
        f"{BACKEND_URL}/experiments",
        headers=api_headers,
        json={
            "name": "pytest-experiment-review",
            "results": [
                {
                    "question": "2+2?",
                    "provider": "openai",
                    "answer": "4",
                    "passed": True,
                    "scores": {"accuracy": 1.0},
                },
                {
                    "question": "3+3?",
                    "provider": "openai",
                    "answer": "7",
                    "passed": False,
                    "scores": {"accuracy": 0.0},
                },
            ],
        },
    )
    create_resp.raise_for_status()
    return create_resp.json()


def test_review_agree_sets_human_verdict_true(api_headers):
    experiment = _create_experiment_with_results(api_headers)
    experiment_id = experiment["id"]
    result = experiment["results"][0]
    result_id = result["id"]

    review_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{experiment_id}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": True},
    )
    assert review_resp.status_code == 200, review_resp.text
    body = review_resp.json()
    assert body["human_verdict"] is True
    assert body["reviewed_at"] is not None

    get_resp = requests.get(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert get_resp.status_code == 200, get_resp.text
    reviewed = next(r for r in get_resp.json()["results"] if r["id"] == result_id)
    assert reviewed["human_verdict"] is True
    assert reviewed["reviewed_at"] is not None


def test_review_disagree_sets_human_verdict_false(api_headers):
    experiment = _create_experiment_with_results(api_headers)
    experiment_id = experiment["id"]
    result = experiment["results"][1]
    result_id = result["id"]

    review_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{experiment_id}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": False},
    )
    assert review_resp.status_code == 200, review_resp.text
    body = review_resp.json()
    assert body["human_verdict"] is False
    assert body["reviewed_at"] is not None

    get_resp = requests.get(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert get_resp.status_code == 200, get_resp.text
    reviewed = next(r for r in get_resp.json()["results"] if r["id"] == result_id)
    assert reviewed["human_verdict"] is False
    assert reviewed["reviewed_at"] is not None


def test_unreviewed_result_has_null_verdict_and_timestamp(api_headers):
    experiment = _create_experiment_with_results(api_headers)
    experiment_id = experiment["id"]

    get_resp = requests.get(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert get_resp.status_code == 200, get_resp.text
    for r in get_resp.json()["results"]:
        assert r["human_verdict"] is None
        assert r["reviewed_at"] is None


def test_review_does_not_change_passed_or_scores(api_headers):
    experiment = _create_experiment_with_results(api_headers)
    experiment_id = experiment["id"]
    result = experiment["results"][0]
    result_id = result["id"]
    original_passed = result["passed"]
    original_scores = result["scores"]

    review_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{experiment_id}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": True},
    )
    assert review_resp.status_code == 200, review_resp.text
    body = review_resp.json()
    assert body["passed"] == original_passed
    assert body["scores"] == original_scores

    get_resp = requests.get(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert get_resp.status_code == 200, get_resp.text
    reviewed = next(r for r in get_resp.json()["results"] if r["id"] == result_id)
    assert reviewed["passed"] == original_passed
    assert reviewed["scores"] == original_scores


def test_reviewing_same_result_twice_overwrites_verdict_and_timestamp(api_headers):
    experiment = _create_experiment_with_results(api_headers)
    experiment_id = experiment["id"]
    result = experiment["results"][0]
    result_id = result["id"]
    original_passed = result["passed"]
    original_scores = result["scores"]

    first_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{experiment_id}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": True},
    )
    assert first_resp.status_code == 200, first_resp.text
    first_body = first_resp.json()
    assert first_body["human_verdict"] is True
    first_reviewed_at = first_body["reviewed_at"]
    assert first_reviewed_at is not None

    second_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{experiment_id}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": False},
    )
    assert second_resp.status_code == 200, second_resp.text
    second_body = second_resp.json()
    assert second_body["human_verdict"] is False
    assert second_body["reviewed_at"] is not None
    assert second_body["reviewed_at"] != first_reviewed_at
    assert datetime.fromisoformat(second_body["reviewed_at"]) > datetime.fromisoformat(first_reviewed_at)
    assert second_body["passed"] == original_passed
    assert second_body["scores"] == original_scores


def test_review_result_from_different_experiment_returns_404(api_headers):
    experiment_a = _create_experiment_with_results(api_headers)
    experiment_b = _create_experiment_with_results(api_headers)
    result_id = experiment_a["results"][0]["id"]

    review_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{experiment_b['id']}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": True},
    )
    assert review_resp.status_code == 404


def test_review_nonexistent_experiment_returns_404(api_headers):
    experiment = _create_experiment_with_results(api_headers)
    result_id = experiment["results"][0]["id"]

    review_resp = requests.patch(
        f"{BACKEND_URL}/experiments/{uuid.uuid4()}/results/{result_id}/review",
        headers=api_headers,
        json={"agree": True},
    )
    assert review_resp.status_code == 404
