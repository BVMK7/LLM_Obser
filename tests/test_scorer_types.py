"""
Integration tests for the two deterministic (non-LLM) scorer types added
alongside the existing implicit LLM-judge scorer: pattern_match (regex or
substring match against a Scorer's output) and json_valid (does the output
parse as valid JSON via the stdlib json module).

Every case run through /evaluation/run_one still calls the real provider to
generate an answer and the real built-in judge (see _run_eval_case) — this
suite can't control that text verbatim, so each question is worded to make
the expected answer as predictable as realistically possible, and pattern
choices are picked to be resilient to small formatting variance (e.g. an
LLM capitalizing the first letter of a word). Run with the backend +
Postgres already up and migrated:
    pytest tests/test_scorer_types.py -v
"""

import os
import uuid

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _post_raw(path, headers, body=None):
    return requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})


def _get(path, headers):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers)
    resp.raise_for_status()
    return resp.json()


def _make_scorer(api_headers, **overrides):
    body = {"name": f"pytest-scorer-{uuid.uuid4().hex[:8]}", "pass_threshold": 0.5}
    body.update(overrides)
    return _post("/scorers", api_headers, body)


def test_pattern_match_substring_scores_match_and_no_match(api_headers):
    # A substring that survives an LLM capitalizing only the first letter of
    # the instructed word ("Banana" vs "banana" both contain "anana").
    scorer = _make_scorer(api_headers, scorer_type="pattern_match", pattern="anana", pattern_is_regex=False)

    match_result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": "Reply with exactly the single word: banana. Nothing else, no punctuation.",
        "scorer_slugs": [scorer["slug"]],
    })
    assert match_result["scorer_scores"].get(scorer["name"]) == 1.0

    no_match_result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": "Reply with exactly the single word: yes. Nothing else, no punctuation.",
        "scorer_slugs": [scorer["slug"]],
    })
    assert no_match_result["scorer_scores"].get(scorer["name"]) == 0.0


def test_pattern_match_regex_scores_a_digit_response(api_headers):
    scorer = _make_scorer(api_headers, scorer_type="pattern_match", pattern=r"\d", pattern_is_regex=True)

    result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": "What is 7 plus 5? Reply with ONLY the numeral, no words.",
        "scorer_slugs": [scorer["slug"]],
    })
    assert result["scorer_scores"].get(scorer["name"]) == 1.0


def test_pattern_match_invalid_regex_fails_gracefully_not_500(api_headers):
    scorer = _make_scorer(api_headers, scorer_type="pattern_match", pattern="(unclosed", pattern_is_regex=True)

    result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": "Say hello in one short sentence.",
        "scorer_slugs": [scorer["slug"]],
    })
    # score=None is never written into scorer_scores (see _run_eval_case:
    # `if result["score"] is not None`), so the invalid-regex scorer's name
    # simply doesn't appear — the whole request still succeeds (200), it
    # never 500s.
    assert scorer["name"] not in result["scorer_scores"]


def test_json_valid_scores_valid_and_invalid_json(api_headers):
    scorer = _make_scorer(api_headers, scorer_type="json_valid")

    valid_result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": 'Respond with ONLY this exact text and nothing else, no markdown, no code fences, no explanation: {"ok": true}',
        "scorer_slugs": [scorer["slug"]],
    })
    assert valid_result["scorer_scores"].get(scorer["name"]) == 1.0

    invalid_result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": "Say hello in one short, plain sentence.",
        "scorer_slugs": [scorer["slug"]],
    })
    assert invalid_result["scorer_scores"].get(scorer["name"]) == 0.0


def test_llm_judge_requires_prompt_template(api_headers):
    resp = _post_raw("/scorers", api_headers, {
        "name": f"pytest-scorer-{uuid.uuid4().hex[:8]}",
        "scorer_type": "llm_judge",
        # prompt_template and choice_scores both omitted on purpose.
    })
    assert resp.status_code == 422


def test_pattern_match_requires_pattern(api_headers):
    resp = _post_raw("/scorers", api_headers, {
        "name": f"pytest-scorer-{uuid.uuid4().hex[:8]}",
        "scorer_type": "pattern_match",
        # pattern omitted on purpose.
    })
    assert resp.status_code == 422


def test_pre_existing_style_llm_judge_scorer_still_works_end_to_end(api_headers):
    # Old-shaped payload: no scorer_type/pattern/pattern_is_regex keys at
    # all, relying entirely on ScorerCreate's scorer_type="llm_judge"
    # default and the DB column's matching server_default — simulating a
    # scorer created before this migration shipped.
    scorer = _post("/scorers", api_headers, {
        "name": f"pytest-legacy-scorer-{uuid.uuid4().hex[:8]}",
        "prompt_template": "Respond with exactly the word: pass",
        "choice_scores": {"pass": 1.0, "fail": 0.0},
        "pass_threshold": 0.5,
    })
    assert scorer["scorer_type"] == "llm_judge"
    assert scorer["pattern"] is None
    assert scorer["pattern_is_regex"] is False

    result = _post("/evaluation/run_one", api_headers, {
        "provider": "groq",
        "question": "irrelevant — the scorer's own prompt_template ignores the question content",
        "scorer_slugs": [scorer["slug"]],
    })
    assert result["scorer_scores"].get(scorer["name"]) == 1.0
