"""
Integration tests for GET /experiments/{id}/significance -- McNemar's test
(paired pass/fail) and Wilcoxon signed-rank test (paired per-scorer 0-1
scores) over two experiments' results, paired by (question, provider)
exactly like frontend/src/pages/ExperimentDetail.jsx's matchedRows.

Unlike tests/test_scorer_types.py, these tests don't need a real LLM call at
all -- POST /experiments accepts already-computed results inline (the same
"Save as Experiment" shape tests/test_experiments.py already uses), so every
pass/fail pattern and score value here is hand-picked and the expected
p-value/significance direction is either exactly known (agree-on-everything
-> p=1.0) or trivially predictable (a large systematic flip -> a very low
p-value).

One test below (test_wilcoxon_all_identical_scores_n14_is_not_significant)
is a regression test added during Task 1's fix round: scipy.stats.wilcoxon's
behavior on an all-zero-difference input (every paired score identical) is
NOT reliable across n -- on scipy 1.17.1 (the version this app pins), it
raises ValueError for small n but silently returns pvalue=nan with no
exception at all for n >= 14. _wilcoxon_test (in main.py) must detect the
all-equal case itself, before ever calling stats.wilcoxon, rather than
relying on catching an exception that doesn't reliably fire. n=14 is the
smallest n that reproduces the nan behavior -- the n=10 all-identical case
covered separately below would not have caught this.

Run with the backend + Postgres already up and migrated:
    pytest tests/test_experiment_significance.py -v
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


def _make_experiment(api_headers, name, results):
    return _post("/experiments", api_headers, {"name": name, "results": results})


def _significance(api_headers, experiment_id, compare_id):
    return _get(f"/experiments/{experiment_id}/significance?compare_id={compare_id}", api_headers)


def _mcnemar_for(sig, provider):
    return next(m for m in sig["mcnemar"] if m["provider"] == provider)


def _wilcoxon_for(sig, provider, scorer_key):
    return next(w for w in sig["wilcoxon"] if w["provider"] == provider and w["scorer_key"] == scorer_key)


def test_identical_pass_fail_pattern_is_not_significant(api_headers):
    # Both experiments agree on every one of 12 paired cases -- b == c == 0,
    # McNemar's special-cased "no discordant pairs" branch: p_value must be
    # exactly 1.0, never computed via the binomial/chi-square math.
    results_a = [
        {"question": f"q{i}", "provider": "groq", "answer": "x", "passed": i % 2 == 0} for i in range(12)
    ]
    results_b = [
        {"question": f"q{i}", "provider": "groq", "answer": "y", "passed": i % 2 == 0} for i in range(12)
    ]
    exp_a = _make_experiment(api_headers, "pytest-sig-identical-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-identical-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    mcnemar = _mcnemar_for(sig, "groq")
    assert mcnemar["n"] == 12
    assert mcnemar["b"] == 0
    assert mcnemar["c"] == 0
    assert mcnemar["p_value"] == 1.0
    assert mcnemar["significant"] is False
    assert mcnemar["low_power"] is False  # n=12 >= 10


def test_large_systematic_flip_is_significant(api_headers):
    # Every one of 20 paired cases flips from pass (A) to fail (B) -- b=20,
    # c=0, a large, obvious, entirely one-directional discordance. This must
    # produce a low p-value and significant=True; a real bug (e.g. swapped
    # b/c, wrong tail) would show up as this assertion failing.
    results_a = [{"question": f"q{i}", "provider": "groq", "answer": "x", "passed": True} for i in range(20)]
    results_b = [{"question": f"q{i}", "provider": "groq", "answer": "y", "passed": False} for i in range(20)]
    exp_a = _make_experiment(api_headers, "pytest-sig-flip-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-flip-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    mcnemar = _mcnemar_for(sig, "groq")
    assert mcnemar["n"] == 20
    assert mcnemar["b"] == 20
    assert mcnemar["c"] == 0
    assert mcnemar["p_value"] < 0.001
    assert mcnemar["significant"] is True
    assert mcnemar["low_power"] is False


def test_small_paired_sample_is_flagged_low_power_but_still_shown(api_headers):
    # Only 4 paired cases -- below the n < 10 low_power threshold. The
    # approved design requires the result to still be returned (p-value
    # always shown), just with low_power=True, never omitted.
    results_a = [{"question": f"q{i}", "provider": "groq", "answer": "x", "passed": True} for i in range(4)]
    results_b = [{"question": f"q{i}", "provider": "groq", "answer": "y", "passed": False} for i in range(4)]
    exp_a = _make_experiment(api_headers, "pytest-sig-lowpower-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-lowpower-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    mcnemar = _mcnemar_for(sig, "groq")
    assert mcnemar["n"] == 4
    assert mcnemar["low_power"] is True
    assert isinstance(mcnemar["p_value"], float)  # present, not omitted


def test_wilcoxon_identical_scores_is_not_significant(api_headers):
    # Every paired score is exactly equal -- scipy.stats.wilcoxon raises
    # ValueError on all-zero differences; the endpoint must catch this and
    # report p_value=1.0, not 500.
    results_a = [
        {"question": f"q{i}", "provider": "groq", "answer": "x", "scores": {"faithfulness": 0.8}} for i in range(10)
    ]
    results_b = [
        {"question": f"q{i}", "provider": "groq", "answer": "y", "scores": {"faithfulness": 0.8}} for i in range(10)
    ]
    exp_a = _make_experiment(api_headers, "pytest-sig-wilcoxon-tie-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-wilcoxon-tie-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    wilcoxon = _wilcoxon_for(sig, "groq", "faithfulness")
    assert wilcoxon["n"] == 10
    assert wilcoxon["p_value"] == 1.0
    assert wilcoxon["significant"] is False


def test_wilcoxon_large_systematic_score_gap_is_significant(api_headers):
    # A obviously scores much higher than B on every one of 15 paired cases
    # -- a real, large, one-directional difference should produce a low
    # p-value.
    results_a = [
        {"question": f"q{i}", "provider": "groq", "answer": "x", "scores": {"faithfulness": 0.95}} for i in range(15)
    ]
    results_b = [
        {"question": f"q{i}", "provider": "groq", "answer": "y", "scores": {"faithfulness": 0.20}} for i in range(15)
    ]
    exp_a = _make_experiment(api_headers, "pytest-sig-wilcoxon-gap-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-wilcoxon-gap-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    wilcoxon = _wilcoxon_for(sig, "groq", "faithfulness")
    assert wilcoxon["n"] == 15
    assert wilcoxon["p_value"] < 0.001
    assert wilcoxon["significant"] is True
    assert wilcoxon["low_power"] is False


def test_pairing_mirrors_frontend_matched_rows_by_question_and_provider(api_headers):
    # A has two providers; B only has a match for one of them (same
    # question+provider key) and has an unrelated extra row that must NOT
    # be paired to anything. Only the matched (question, provider) pair
    # feeds the test -- the unmatched "groq" row in A contributes nothing.
    results_a = [
        {"question": "capital of france", "provider": "groq", "answer": "Paris", "passed": True},
        {"question": "capital of spain", "provider": "groq", "answer": "Madrid", "passed": True},
    ]
    results_b = [
        {"question": "capital of france", "provider": "groq", "answer": "Paris", "passed": True},
        {"question": "capital of italy", "provider": "gemini", "answer": "Rome", "passed": True},  # no match in A
    ]
    exp_a = _make_experiment(api_headers, "pytest-sig-pairing-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-pairing-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    mcnemar = _mcnemar_for(sig, "groq")
    assert mcnemar["n"] == 1  # only "capital of france" matched; "capital of spain" has no B counterpart
    assert not any(m["provider"] == "gemini" for m in sig["mcnemar"])  # B's unmatched gemini row never appears


def test_significance_404s_for_missing_experiment_and_missing_compare(api_headers):
    exp_a = _make_experiment(api_headers, "pytest-sig-404-a", [
        {"question": "q", "provider": "groq", "answer": "x", "passed": True}
    ])
    fake_id = "00000000-0000-0000-0000-000000000000"

    resp_missing_primary = requests.get(
        f"{BACKEND_URL}/experiments/{fake_id}/significance?compare_id={exp_a['id']}", headers=api_headers
    )
    assert resp_missing_primary.status_code == 404

    resp_missing_compare = requests.get(
        f"{BACKEND_URL}/experiments/{exp_a['id']}/significance?compare_id={fake_id}", headers=api_headers
    )
    assert resp_missing_compare.status_code == 404


def test_significance_requires_compare_id_query_param(api_headers):
    exp_a = _make_experiment(api_headers, "pytest-sig-missing-param-a", [
        {"question": "q", "provider": "groq", "answer": "x", "passed": True}
    ])
    resp = requests.get(f"{BACKEND_URL}/experiments/{exp_a['id']}/significance", headers=api_headers)
    assert resp.status_code == 422


def test_mcnemar_chi_square_branch_with_26_discordant_pairs(api_headers):
    # 26 discordant pairs (all A-passed/B-failed, b=26, c=0) crosses the
    # b+c >= 25 threshold into the chi-square-with-continuity-correction
    # branch -- the one hand-written-formula path in this feature with no
    # prior test coverage. Expected: chi2_stat = (26-1)**2/26 ~= 24.038,
    # p_value = scipy.stats.chi2.sf(24.038, df=1) ~= 9.44e-7.
    results_a = [{"question": f"q{i}", "provider": "groq", "answer": "x", "passed": True} for i in range(26)]
    results_b = [{"question": f"q{i}", "provider": "groq", "answer": "y", "passed": False} for i in range(26)]
    exp_a = _make_experiment(api_headers, "pytest-sig-chisq-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-chisq-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    mcnemar = _mcnemar_for(sig, "groq")
    assert mcnemar["n"] == 26
    assert mcnemar["b"] == 26
    assert mcnemar["c"] == 0
    assert mcnemar["p_value"] < 0.001
    assert mcnemar["significant"] is True


def test_significance_rejects_comparing_experiment_to_itself(api_headers):
    exp = _make_experiment(api_headers, "pytest-sig-self-compare", [
        {"question": "q", "provider": "groq", "answer": "x", "passed": True}
    ])
    resp = requests.get(
        f"{BACKEND_URL}/experiments/{exp['id']}/significance",
        headers=api_headers,
        params={"compare_id": exp["id"]},
    )
    assert resp.status_code == 400


def test_no_overlapping_scorer_keys_returns_empty_wilcoxon(api_headers):
    results_a = [{"question": "q", "provider": "groq", "answer": "x", "scores": {"faithfulness": 0.9}}]
    results_b = [{"question": "q", "provider": "groq", "answer": "y", "scores": {"relevance": 0.5}}]
    exp_a = _make_experiment(api_headers, "pytest-sig-no-overlap-a", results_a)
    exp_b = _make_experiment(api_headers, "pytest-sig-no-overlap-b", results_b)

    sig = _significance(api_headers, exp_a["id"], exp_b["id"])
    assert sig["wilcoxon"] == []


def test_significance_404s_when_compare_belongs_to_different_project(api_headers, admin_headers):
    # A second, unrelated project's experiment should 404 exactly like a
    # nonexistent one -- confirms the ownership check, not just existence.
    other_project = requests.post(
        f"{BACKEND_URL}/projects", headers=admin_headers, json={"name": f"pytest-sig-other-{uuid.uuid4()}"}
    )
    other_project.raise_for_status()
    other_project = other_project.json()
    other_headers = {"X-API-Key": other_project["api_key"], "Content-Type": "application/json"}
    try:
        other_exp = _make_experiment(other_headers, "pytest-sig-other-project-exp", [
            {"question": "q", "provider": "groq", "answer": "x", "passed": True}
        ])
        my_exp = _make_experiment(api_headers, "pytest-sig-mine", [
            {"question": "q", "provider": "groq", "answer": "x", "passed": True}
        ])
        resp = requests.get(
            f"{BACKEND_URL}/experiments/{my_exp['id']}/significance",
            headers=api_headers,
            params={"compare_id": other_exp["id"]},
        )
        assert resp.status_code == 404
    finally:
        requests.delete(f"{BACKEND_URL}/projects/{other_project['id']}", headers=admin_headers)


def test_wilcoxon_all_identical_scores_n14_is_not_significant(api_headers):
    """14 paired rows with byte-identical scores on both sides -- the exact
    n that returns pvalue=nan (not a ValueError) from the installed scipy.
    Must come back as the correct statistical answer (no evidence of any
    difference -> p_value 1.0, not significant), never null/nan."""

    def _n14_results(provider="openai"):
        return [
            {
                "question": f"q{i}",
                "provider": provider,
                "answer": "identical answer",
                "passed": True,
                "scores": {"quality": 0.8},
            }
            for i in range(14)
        ]

    primary = _make_experiment(api_headers, f"sig-wilcoxon-{uuid.uuid4().hex[:8]}", _n14_results())
    compare = _make_experiment(api_headers, f"sig-wilcoxon-{uuid.uuid4().hex[:8]}", _n14_results())

    sig = _significance(api_headers, primary["id"], compare["id"])
    wilcoxon_results = [w for w in sig["wilcoxon"] if w["scorer_key"] == "quality"]
    assert len(wilcoxon_results) == 1
    result = wilcoxon_results[0]
    assert result["n"] == 14
    assert result["p_value"] == 1.0
    assert result["significant"] is False
