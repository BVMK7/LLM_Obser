"""
Regression test for GET /experiments/{experiment_id}/significance's
Wilcoxon signed-rank helper (_wilcoxon_test in main.py).

Hits a REAL, already-running backend + Postgres over real HTTP, same
convention as every other test in this suite (see conftest.py). Start the
backend yourself (`python -m uvicorn main:app --port 8010`, with Postgres
up and migrated) before running:
    pytest tests/test_experiment_significance.py -v

This test exists specifically because scipy.stats.wilcoxon's behavior on
an all-zero-difference input (every paired score identical) is NOT
reliable across n: on scipy 1.17.1 (the version this app pins), it raises
ValueError for small n but silently returns pvalue=nan with no exception
at all for n >= 14. _wilcoxon_test must detect the all-equal case itself,
before ever calling stats.wilcoxon, rather than relying on catching an
exception that doesn't reliably fire. n=14 is the smallest n that
reproduces the nan behavior -- a lower n (e.g. the n=10 case Task 2's plan
separately covers) would not have caught this.
"""

import os
import uuid

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _post(path, headers, body):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body)
    resp.raise_for_status()
    return resp.json()


def _make_experiment(api_headers, n, provider="openai"):
    results = [
        {
            "question": f"q{i}",
            "provider": provider,
            "answer": "identical answer",
            "passed": True,
            "scores": {"quality": 0.8},
        }
        for i in range(n)
    ]
    return _post(
        "/experiments",
        api_headers,
        {"name": f"sig-wilcoxon-{uuid.uuid4().hex[:8]}", "providers": [provider], "scorer_slugs": [], "results": results},
    )


def test_wilcoxon_all_identical_scores_n14_is_not_significant(api_headers):
    """14 paired rows with byte-identical scores on both sides -- the exact
    n that returns pvalue=nan (not a ValueError) from the installed scipy.
    Must come back as the correct statistical answer (no evidence of any
    difference -> p_value 1.0, not significant), never null/nan."""
    primary = _make_experiment(api_headers, n=14)
    compare = _make_experiment(api_headers, n=14)

    resp = requests.get(
        f"{BACKEND_URL}/experiments/{primary['id']}/significance",
        headers=api_headers,
        params={"compare_id": compare["id"]},
    )
    resp.raise_for_status()
    body = resp.json()

    wilcoxon_results = [w for w in body["wilcoxon"] if w["scorer_key"] == "quality"]
    assert len(wilcoxon_results) == 1
    result = wilcoxon_results[0]
    assert result["n"] == 14
    assert result["p_value"] == 1.0
    assert result["significant"] is False
