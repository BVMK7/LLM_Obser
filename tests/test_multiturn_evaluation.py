"""
Integration tests for POST /evaluation/run_conversation -- multi-turn
conversation evaluation with real accumulated message history, per-turn
keyword checks, and one overall LLM-judge verdict over the whole
transcript.

Unlike tests/test_experiment_significance.py, these tests DO make real
LLM calls (there's no way to test "does conversation history actually
get carried forward" without a real model actually using it) -- each
question is worded to make the expected behavior as predictable as
realistically possible. Run with the backend + Postgres already up and
migrated:
    pytest tests/test_multiturn_evaluation.py -v
"""

import os

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


def _run_conversation(api_headers, provider, turns):
    return _post("/evaluation/run_conversation", api_headers, {"provider": provider, "turns": turns})


def test_context_carries_across_turns(api_headers):
    # Turn 2 can ONLY be answered correctly if the model actually saw turn
    # 1's real answer as part of its own message history -- this is the
    # core claim of "multi-turn," not just "N single-turn calls in a row."
    result = _run_conversation(api_headers, "groq", [
        {"question": "My favorite color is teal. Just acknowledge that in one short sentence.", "expected": None},
        {"question": "What is my favorite color? Answer with just the color name.", "expected": "teal"},
    ])
    assert result["error"] is None
    assert len(result["turns"]) == 2
    assert result["turns"][0]["passed"] is None  # no expected given on turn 1
    assert result["turns"][1]["passed"] is True
    assert result["trace_id"] is not None

    trace = _get(f"/traces/{result['trace_id']}", api_headers)
    assert trace["name"] == "eval-conversation: groq"
    names = [s["step_name"] for s in trace["spans"]]
    assert names.count("judge:conversation") == 1
    assert len([n for n in names if n.startswith("judge:")]) == 1  # never one judge per turn
    assert {"turn_1", "turn_2"} <= set(names)


def test_multiturn_conversation_passes_end_to_end(api_headers):
    result = _run_conversation(api_headers, "groq", [
        {"question": "What is 10 plus 5? Reply with ONLY the numeral.", "expected": "15"},
        {"question": "Now add 5 more to that. Reply with ONLY the numeral.", "expected": "20"},
    ])
    assert result["error"] is None
    assert result["turns"][0]["passed"] is True
    assert result["turns"][1]["passed"] is True
    assert result["passed"] is True
    assert result["faithfulness"] is not None
    assert result["hallucination"] is not None


def test_single_turn_keyword_mismatch_does_not_fail_other_turns(api_headers):
    result = _run_conversation(api_headers, "groq", [
        {"question": "What is 2 plus 2? Reply with ONLY the numeral.", "expected": "4"},
        {"question": "Reply with exactly the word: WRONGWORD_NEVER_APPEARS", "expected": "this string will never match"},
        {"question": "What is 3 plus 3? Reply with ONLY the numeral.", "expected": "6"},
    ])
    assert result["turns"][0]["passed"] is True
    assert result["turns"][1]["passed"] is False
    assert result["turns"][2]["passed"] is True


def test_no_expected_on_any_turn_gives_null_per_turn_passed(api_headers):
    result = _run_conversation(api_headers, "groq", [
        {"question": "Say hello in one short sentence.", "expected": None},
        {"question": "Now say goodbye in one short sentence.", "expected": None},
    ])
    assert result["turns"][0]["passed"] is None
    assert result["turns"][1]["passed"] is None
    assert result["passed"] in (True, False)  # the overall judge still ran and returned a real verdict


def test_invalid_provider_returns_422(api_headers):
    resp = _post_raw("/evaluation/run_conversation", api_headers, {
        "provider": "not-a-real-provider",
        "turns": [{"question": "hello", "expected": None}],
    })
    assert resp.status_code == 422


def test_multiturn_result_round_trips_through_experiments(api_headers):
    conversation = _run_conversation(api_headers, "groq", [
        {"question": "What is 1 plus 1? Reply with ONLY the numeral.", "expected": "2"},
        {"question": "What is 2 plus 2? Reply with ONLY the numeral.", "expected": "4"},
    ])
    experiment = _post("/experiments", api_headers, {
        "name": "pytest-multiturn-experiment",
        "results": [{
            "question": conversation["turns"][0]["question"],
            "provider": conversation["provider"],
            "answer": conversation["turns"][-1]["answer"],
            "passed": conversation["passed"],
            "turns": conversation["turns"],
        }],
    })
    assert len(experiment["results"]) == 1
    saved = experiment["results"][0]
    assert saved["turns"] is not None
    assert len(saved["turns"]) == 2
    assert saved["turns"][0]["question"] == conversation["turns"][0]["question"]


def test_single_turn_experiment_result_has_null_turns(api_headers):
    # Regression check: an ordinary single-turn result (no turns key sent
    # at all) must still round-trip with turns=None -- this feature must
    # never break the existing single-turn path.
    experiment = _post("/experiments", api_headers, {
        "name": "pytest-singleturn-regression",
        "results": [{"question": "q", "provider": "groq", "answer": "a", "passed": True}],
    })
    assert experiment["results"][0]["turns"] is None
