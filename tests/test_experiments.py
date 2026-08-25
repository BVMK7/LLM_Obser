"""
Regression coverage for DELETE /experiments/{id}.

Experiment.results lacked passive_deletes, so SQLAlchemy's unit-of-work
auto-loaded the (untouched) results collection on parent delete specifically
to null out each row's experiment_id — violating experiment_results'
NOT NULL FK column even though the table's own ON DELETE CASCADE would have
handled it correctly. Same bug class as Trace.spans/Trace.scores, fixed the
same way: passive_deletes="all".
"""

import os

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def test_delete_experiment_with_results_succeeds(api_headers):
    create_resp = requests.post(
        f"{BACKEND_URL}/experiments",
        headers=api_headers,
        json={
            "name": "pytest-experiment",
            "results": [
                {"question": "2+2?", "provider": "openai", "answer": "4", "passed": True},
                {"question": "3+3?", "provider": "openai", "answer": "6", "passed": True},
            ],
        },
    )
    create_resp.raise_for_status()
    experiment_id = create_resp.json()["id"]
    assert len(create_resp.json()["results"]) == 2

    delete_resp = requests.delete(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert delete_resp.status_code == 200, delete_resp.text

    get_resp = requests.get(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert get_resp.status_code == 404


def test_delete_experiment_without_results_succeeds(api_headers):
    create_resp = requests.post(
        f"{BACKEND_URL}/experiments", headers=api_headers, json={"name": "pytest-experiment-empty"}
    )
    create_resp.raise_for_status()
    experiment_id = create_resp.json()["id"]

    delete_resp = requests.delete(f"{BACKEND_URL}/experiments/{experiment_id}", headers=api_headers)
    assert delete_resp.status_code == 200, delete_resp.text
