# Multi-turn Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Evaluation Suite to support fixed, scripted multi-turn conversations — real conversation history sent to the provider each turn, per-turn keyword checks, and one overall LLM-judge verdict over the whole transcript — stored alongside today's single-turn results in the same `ExperimentResult` table.

**Architecture:** A new `_run_multiturn_eval_case` function loops through author-written turns, accumulating an OpenAI-style `messages` list and calling the same provider functions `_run_eval_case` already uses (`providers.py`'s `call_gemini`/`call_groq`/`call_openrouter` already accept a full message list — no provider-layer changes). One new `_judge_conversation` function grades the completed transcript as a whole. Results are exposed via a new `POST /evaluation/run_conversation` endpoint and stored as an `ExperimentResult` with a new nullable `turns` JSONB column holding the per-turn breakdown.

**Tech Stack:** FastAPI + Pydantic + SQLAlchemy + Postgres (backend, `main.py`), React (frontend, `frontend/src/pages/Evaluation.jsx`), pytest + `requests` (live-server integration tests).

**Spec:** `docs/superpowers/specs/2026-09-03-multiturn-evaluation-design.md`

## Global Constraints

- **Fixed script only** — every turn is authored upfront by the case's author (question + optional expected keyword). No dynamic/simulated-user follow-up generation.
- **Per-turn keyword match, ONE overall judge call** — never a judge call per turn. Each turn's `passed` comes from the same case-insensitive substring check `_run_eval_case` already uses (`expected.strip().lower() in answer.lower()`, `None` if no `expected` given). The conversation's overall `passed`/`faithfulness`/`relevance`/`hallucination` come from exactly one `_judge_conversation` call after the last turn.
- **Real conversation history, not N independent calls.** Each turn's provider call must receive every prior turn's question AND that turn's own real answer as `messages`, not just its own question in isolation — this is what makes it genuinely multi-turn. Verify this explicitly in tests (Task 2's context-retention test), don't just assume it from writing the loop correctly.
- **No provider-layer changes.** `providers.py`'s `call_gemini`/`call_groq`/`call_openrouter` and `_normalize_messages` already accept a full `messages` list — do not modify `providers.py` at all in this plan.
- **On any turn's provider-call exception:** stop immediately, do NOT attempt remaining turns, do NOT log any `Trace`/`Span` at all (exactly mirroring `_run_eval_case`'s own provider-exception branch), and return a result with `trace_id=None`, `passed=False`, `faithfulness`/`relevance`/`hallucination`/`judge_notes` all `None` (the judge never ran).
- **No custom Scorers on multi-turn conversations** in this cut — only the one built-in `_judge_conversation` call. Explicitly out of scope, per the spec.
- **No dataset save/load UI for multi-turn cases** in this cut — only ad-hoc runs from the Evaluation Suite's own case editor. (`Dataset.cases` technically already supports a `turns`-shaped `EvalCase` with zero schema changes, since `Dataset.cases` is a JSONB list of whatever `EvalCase` shape is sent — this plan just doesn't build/test that path.)
- **No per-provider comparison for multi-turn** — one provider per conversation submit, unlike single-turn's multi-provider checkbox row.
- **This repo's only testing convention is live-server integration tests** over real HTTP (`tests/conftest.py`'s fixtures, unchanged) — no in-process `TestClient`, no mocking of provider calls.
- Nothing pushed to `origin/main` until the user says so — commit locally only.

---

### Task 1: Data model, migration, judge function, multi-turn eval function, endpoint

**Files:**
- Modify: `main.py` — new `TurnCase` class + `EvalCase.turns` field (insert `TurnCase` immediately before `EvalCase`, `main.py:948-951`), new `TurnResult` class + `ExperimentResultIn.turns` field (insert `TurnResult` immediately before `ExperimentResultIn`, `main.py:1118-1141`), new `_judge_conversation` function (insert after `_judge_answer`, `main.py:3048-3073`), new `_run_multiturn_eval_case` function (insert after `_run_eval_case`, `main.py:3524-3645`), new `EvalConversationRequest`/`ConversationResult` classes + `POST /evaluation/run_conversation` endpoint (insert after `run_evaluation_one`, `main.py:3663-3667`). `TurnCase`/`TurnResult` MUST be defined before the model that first references them (Pydantic resolves a model field's type at class-definition time) — see the note before Step 2.
- Create: `add_multiturn_evaluation.sql`
- Modify: `.github/workflows/eval.yml` — append the new migration file to the ordered `for f in ...` list, after `add_scorer_types.sql` (the current last entry)

**Interfaces:**
- Produces: `POST /evaluation/run_conversation` accepting `EvalConversationRequest` (`provider: ProviderName`, `turns: list[TurnCase]`) and returning `ConversationResult` (`provider`, `turns: list[TurnResult]`, `passed`, `faithfulness`, `relevance`, `hallucination`, `judge_notes`, `input_tokens`, `output_tokens`, `total_tokens`, `cost`, `latency_ms`, `trace_id`, `error`). Task 2's tests and Task 3's frontend both consume this exact response shape and these exact field names.
- Produces: `ExperimentResultIn`/`ExperimentResultResponse` gain `turns: Optional[list[TurnResult]] = None` — `null` for every existing single-turn row, populated for multi-turn ones. Task 2's tests verify this round-trips through `POST /experiments`.

- [ ] **Step 1: Read the actual current file first**

Read `main.py` around lines 939-952 (`EvalCase`), 1118-1141 (`ExperimentResultIn`/`ExperimentResultResponse`), 3015-3073 (`EvalCaseResult`/`_judge_answer`), 3520-3667 (`_run_eval_case`/`EvalSingleRequest`/`run_evaluation_one`) to confirm nothing has shifted since this plan was written — other work may have touched this file. Adjust insertion points to the real current locations if line numbers have moved; the code below is the authority on *what* to write, not exactly *where*.

Pydantic resolves a model field's type annotation at class-definition
time (unlike a plain function's annotations, which are never eagerly
resolved) — so every step below defines `TurnCase`/`TurnResult` BEFORE
the first model that references them by name, and neither ever needs a
forward-reference string quote (`"TurnCase"`).

- [ ] **Step 2: Add `TurnCase` and extend `EvalCase`**

In `main.py`, immediately BEFORE the current `class EvalCase(BaseModel):` definition, add:

```python
class TurnCase(BaseModel):
    question: str
    expected: Optional[str] = None
```

Then replace the current `EvalCase` class:

```python
class EvalCase(BaseModel):
    id: Optional[str] = None
    question: str
    expected: Optional[str] = None
```

with:

```python
class EvalCase(BaseModel):
    id: Optional[str] = None
    question: str
    expected: Optional[str] = None
    # Multi-turn evaluation -- when set, this case IS this sequence of
    # turns; question/expected above are unused (still required by this
    # model for backward compatibility with every existing single-turn
    # caller). Lives on EvalCase (not a separate model) so a saved
    # Dataset's `cases` can hold a mix of single-turn and multi-turn
    # cases with zero changes to Dataset/DatasetCreate/DatasetResponse.
    turns: Optional[list[TurnCase]] = None
```

- [ ] **Step 3: Add `TurnResult` and extend `ExperimentResultIn`/`ExperimentResultResponse`**

In `main.py`, immediately BEFORE `class ExperimentResultIn(BaseModel):` (search for it), add:

```python
class TurnResult(BaseModel):
    question: str
    expected: Optional[str] = None
    answer: str
    passed: Optional[bool] = None
```

Then add one field at the end of `ExperimentResultIn`:

```python
class ExperimentResultIn(BaseModel):
    question: str
    expected: Optional[str] = None
    provider: str
    model: Optional[str] = None
    answer: str
    passed: Optional[bool] = None
    scores: dict[str, float] = {}
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    trace_id: Optional[uuid.UUID] = None
    # Multi-turn evaluation -- null for every single-turn result (past and
    # future). When set, question/answer above hold the conversation's
    # first question / final answer as a stable summary label, and
    # passed/scores above hold the OVERALL judge verdict for the whole
    # conversation (see _judge_conversation), never a combination of
    # these per-turn results.
    turns: Optional[list[TurnResult]] = None
```

`ExperimentResultResponse(ExperimentResultIn)` inherits `turns` automatically — no change needed there beyond what inheritance already gives it.

- [ ] **Step 4: Create the migration**

Create `add_multiturn_evaluation.sql` (repo root, alongside every other migration file) with exactly:

```sql
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS turns JSONB;
```

In `.github/workflows/eval.yml`, find the `for f in ...` migration loop (it ends with `add_scorer_types.sql`) and append ` add_multiturn_evaluation.sql` to the end of that list (same backslash-continued shell list style already there).

Run `psql -h localhost -p 5433 -U llm_observability -d llm_observability -f add_multiturn_evaluation.sql` (password `llm_observability`, matching this repo's local Postgres — `docker-compose.yml`) to apply it to your local dev database.

- [ ] **Step 5: Add `_judge_conversation`**

In `main.py`, immediately after the existing `_judge_answer` function's closing (search for `def _judge_answer`, insert right after its `except Exception as e: return {...}` line and before the next `_SCORER_PLACEHOLDERS` definition), add:

```python
# Grades an ENTIRE multi-turn conversation at once, unlike _judge_answer's
# single-question-and-answer grading -- this is what catches a conversation
# that fails to use context established in an earlier turn, which no
# per-turn keyword check or per-turn judge call could ever see. Same fixed
# Groq-judge convention, same "never break the eval run" fallback.
def _judge_conversation(turn_results: list["TurnResult"]) -> dict:
    call_groq = PROVIDERS["groq"]
    transcript = "\n".join(
        f"Turn {i + 1} — Question: {t.question} "
        f"Expected (may be empty): {t.expected or '(none provided)'} "
        f"Answer: {t.answer}"
        for i, t in enumerate(turn_results)
    )
    prompt = (
        "You are grading a multi-turn AI assistant conversation for overall quality. "
        f"Full transcript, in order:\n{transcript}\n"
        "Score the CONVERSATION AS A WHOLE and respond with ONLY a JSON object, "
        "no other text, in this exact shape: "
        '{"passed": <true/false>, "faithfulness": <0.0-1.0>, "relevance": <0.0-1.0>, '
        '"hallucination": <true/false>, "notes": "<one short sentence>"} '
        "passed = did the assistant successfully complete the overall task across "
        "all turns, correctly using context established in earlier turns? "
        "faithfulness = does the conversation avoid contradicting any expected facts "
        "given (if any)? relevance = did each answer actually address its own "
        "question? hallucination = true if any answer states specific facts/numbers/"
        "claims not supported by the expected answers or common knowledge."
    )
    try:
        raw, _input_tokens, _output_tokens = call_groq(prompt)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        return {
            "passed": bool(parsed["passed"]),
            "faithfulness": float(parsed["faithfulness"]),
            "relevance": float(parsed["relevance"]),
            "hallucination": bool(parsed["hallucination"]),
            "judge_notes": parsed.get("notes"),
        }
    except Exception as e:
        # passed=None (not False) so a judge outage is visibly distinct
        # from a genuine failed conversation.
        return {"passed": None, "faithfulness": None, "relevance": None, "hallucination": None, "judge_notes": f"(judge failed: {e})"}
```

- [ ] **Step 6: Add `_run_multiturn_eval_case`**

In `main.py`, immediately after `_run_eval_case`'s closing `return EvalCaseResult(...)` (search for `def _run_eval_case`, insert right after its function ends and before the `# Single-pair endpoint` comment / `class EvalSingleRequest` block), add:

```python
# Runs one multi-turn conversation end-to-end: real accumulated message
# history per turn (unlike _run_eval_case's single question/answer), a
# per-turn keyword check, one overall _judge_conversation call, and one
# Trace with one Span per turn plus a judge span -- only ever logged on
# the all-turns-succeeded path (see the per-turn exception branch below,
# which mirrors _run_eval_case's own "never log a partial trace" behavior).
def _run_multiturn_eval_case(turns: list["TurnCase"], provider: str, db: Session, project_id) -> "ConversationResult":
    call_provider = PROVIDERS[provider]
    model_used = MODEL_CATALOG[provider]["default"]

    messages = []
    turn_results = []
    total_input_tokens = 0
    total_output_tokens = 0
    conversation_started_at = None

    for turn in turns:
        messages.append({"role": "user", "content": turn.question})
        turn_started_at = datetime.now(timezone.utc)
        if conversation_started_at is None:
            conversation_started_at = turn_started_at

        try:
            answer, input_tokens, output_tokens = call_provider(messages, model=model_used)
        except Exception as e:
            turn_results.append(TurnResult(question=turn.question, expected=turn.expected, answer=f"Error: {e}", passed=False))
            return ConversationResult(
                provider=provider,
                turns=turn_results,
                passed=False,
                faithfulness=None,
                relevance=None,
                hallucination=None,
                judge_notes=None,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                total_tokens=total_input_tokens + total_output_tokens,
                cost=estimate_cost(model_used, total_input_tokens, total_output_tokens),
                latency_ms=int((datetime.now(timezone.utc) - conversation_started_at).total_seconds() * 1000),
                trace_id=None,
                error=str(e),
            )

        messages.append({"role": "assistant", "content": answer})
        total_input_tokens += input_tokens
        total_output_tokens += output_tokens

        passed = None
        if turn.expected and turn.expected.strip():
            passed = turn.expected.strip().lower() in answer.lower()
        turn_results.append(TurnResult(question=turn.question, expected=turn.expected, answer=answer, passed=passed))

    judge, judge_started, judge_ended = _timed_call(_judge_conversation, turn_results)

    total_tokens = total_input_tokens + total_output_tokens
    cost = estimate_cost(model_used, total_input_tokens, total_output_tokens)
    latency_ms = int((judge_ended - conversation_started_at).total_seconds() * 1000)

    db_trace = _log_trace(
        db,
        project_id=project_id,
        name=f"eval-conversation: {provider}",
        input=turns[0].question,
        output=turn_results[-1].answer,
        started_at=conversation_started_at,
        ended_at=judge_ended,
        total_tokens=total_tokens,
        cost=cost,
        model=model_used,
    )
    for i, tr in enumerate(turn_results):
        _log_span(
            db,
            trace_id=db_trace.id,
            step_name=f"turn_{i + 1}",
            input=tr.question,
            output=tr.answer,
            started_at=conversation_started_at,
            ended_at=judge_started,
        )
    _log_span(
        db,
        trace_id=db_trace.id,
        step_name="judge:conversation",
        input="\n".join(f"Turn {i + 1}: {tr.question}" for i, tr in enumerate(turn_results)),
        output=json.dumps(judge),
        started_at=judge_started,
        ended_at=judge_ended,
    )

    return ConversationResult(
        provider=provider,
        turns=turn_results,
        passed=judge["passed"],
        faithfulness=judge["faithfulness"],
        relevance=judge["relevance"],
        hallucination=judge["hallucination"],
        judge_notes=judge["judge_notes"],
        input_tokens=total_input_tokens,
        output_tokens=total_output_tokens,
        total_tokens=total_tokens,
        cost=cost,
        latency_ms=latency_ms,
        trace_id=db_trace.id,
    )
```

Note: per-turn `Span` timing above uses `conversation_started_at`/`judge_started` as a simplification (this plan does not thread exact per-turn start/end timestamps through the loop) — every turn's span shares the same start/end window rather than its own precise one. This is an accepted simplification for this cut: the Trace's own `started_at`/`ended_at` and the overall `latency_ms` are exact; only the individual turn-span timings within the Timeline view are approximate. Do not "fix" this by adding per-turn timing plumbing — it's not required by the spec and would add real complexity for a cosmetic Timeline-only detail.

- [ ] **Step 7: Add the endpoint**

In `main.py`, immediately after `run_evaluation_one` (search for `def run_evaluation_one`, insert right after its `return _run_eval_case(...)` line and before `@app.post("/evaluation/run"`), add:

```python
class EvalConversationRequest(BaseModel):
    provider: ProviderName
    turns: list[TurnCase]


class ConversationResult(BaseModel):
    provider: str
    turns: list[TurnResult]
    passed: Optional[bool]
    faithfulness: Optional[float] = None
    relevance: Optional[float] = None
    hallucination: Optional[bool] = None
    judge_notes: Optional[str] = None
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost: float
    latency_ms: int
    trace_id: Optional[uuid.UUID]
    error: Optional[str] = None


@app.post("/evaluation/run_conversation", response_model=ConversationResult)
def run_evaluation_conversation(req: EvalConversationRequest, db: Session = Depends(get_db), project: Project = Depends(get_current_project)):
    return _run_multiturn_eval_case(req.turns, req.provider, db, project.id)
```

- [ ] **Step 8: Verify**

`python -m py_compile main.py && python -c "import main"` — clean, no traceback. Restart the local backend. Manually exercise via `curl`:
- `POST /evaluation/run_conversation` with `{"provider": "groq", "turns": [{"question": "My name is Alex. Just acknowledge that.", "expected": null}, {"question": "What is my name?", "expected": "Alex"}]}` → second turn's `passed` should be `true` (proving conversation history actually carried the name forward), `trace_id` should be a real UUID.
- `GET /traces/{trace_id}` on that returned `trace_id` → should show `name: "eval-conversation: groq"` with two `turn_N` spans and one `judge:conversation` span nested under it.
- Same request with an invalid `"provider": "not-a-real-provider"` → 422 (FastAPI's own `ProviderName` Literal validation), confirming the endpoint still rejects a bad provider before ever reaching `_run_multiturn_eval_case`.

- [ ] **Step 9: Commit**

```bash
git add main.py add_multiturn_evaluation.sql .github/workflows/eval.yml
git commit -m "Add multi-turn conversation evaluation endpoint"
```

---

### Task 2: Test suite

**Files:**
- Create: `tests/test_multiturn_evaluation.py`

**Interfaces:**
- Consumes: `project`, `api_headers` fixtures (existing, `tests/conftest.py`, unchanged); `POST /evaluation/run_conversation` from Task 1; `POST /experiments` (existing, accepts inline `results` — see `tests/test_experiments.py`/`tests/test_experiment_significance.py` for the same pattern).

- [ ] **Step 1: Write the tests**

```python
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
```

Note on coverage: the spec's testing plan also calls for a case where a
turn's provider call itself fails mid-conversation (proving `passed=False`,
`trace_id=None`, and `turns` truncated at the failed turn). There is no
live, deterministic, mock-free way to force a real provider call to fail
on demand in this repo's testing convention — the same is already true of
`_run_eval_case`'s own, structurally identical exception branch, which no
existing test in this repo exercises either. This gap is accepted as
pre-existing testing debt, not something to solve by mocking (against this
repo's only convention) or by relying on environment-specific flakiness
(e.g. an intentionally-unset API key). `_run_multiturn_eval_case`'s
exception branch is instead verified by code review against Global
Constraints' exact contract (stop immediately, no `Trace`/`Span` logged,
`trace_id=None`, `passed=False`) during this task's own task review,
the same standard already implicitly applied to `_run_eval_case`'s
identical, equally untested branch.

- [ ] **Step 2: Run and fix**

`python -m pytest tests/test_multiturn_evaluation.py -v` — iterate until green. These tests make real LLM calls (Groq), so an occasional flaky wording mismatch is possible; if `test_context_carries_across_turns` or `test_multiturn_conversation_passes_end_to_end` fails on wording alone (not on a real bug), adjust only the question/expected text to be more unambiguous, never loosen the assertion itself (e.g. never change `passed is True` to `passed in (True, False)`).

- [ ] **Step 3: Full regression run**

Run the full suite properly tracked in the background (never a manually-tailed redirected log — this repo has been repeatedly bitten by Windows stdout buffering making a genuinely-running process look stalled): `python -u -m pytest tests/ -v`. Confirm all pre-existing tests plus the new ones pass. Wait for actual completion.

- [ ] **Step 4: Commit**

```bash
git add tests/test_multiturn_evaluation.py
git commit -m "Add test suite for multi-turn conversation evaluation"
```

---

### Task 3: Frontend UI — multi-turn case editor and results in the Evaluation Suite

**Files:**
- Modify: `frontend/src/api.js` (new `runEvaluationConversation` function, after `runEvaluationOne`)
- Modify: `frontend/src/pages/Evaluation.jsx` (mode toggle, multi-turn case editor, run wiring, results display)

**Interfaces:**
- Consumes: `POST /evaluation/run_conversation` from Task 1, via the new `runEvaluationConversation(provider, turns)` API function.

- [ ] **Step 1: Add the API function**

In `frontend/src/api.js`, read the actual current file first (search for `runEvaluationOne`) and insert immediately after it:

```javascript
// Runs one multi-turn conversation (real accumulated message history per
// turn, one overall judge call) -- see POST /evaluation/run_conversation
// in main.py. One provider per call, unlike single-turn's multi-provider
// loop, since a conversation is one continuous exchange, not something to
// compare providers on within one submit.
export const runEvaluationConversation = (provider, turns) =>
  request("/evaluation/run_conversation", {
    method: "POST",
    body: { provider, turns },
    errorMessage: "Failed to run conversation",
  });
```

Match the exact calling convention `runEvaluationOne` already uses in this same file (method/body/errorMessage argument names) — read it first rather than guessing the shape.

- [ ] **Step 2: Add mode state and the multi-turn case editor**

In `frontend/src/pages/Evaluation.jsx`, read the actual current file first (it may have shifted since this plan was written).

1. Update the import line to add `runEvaluationConversation`:
```javascript
import { getProviderStatus, runEvaluationOne, runEvaluationConversation, getDatasets, getDataset, createDataset, getScorers, createExperiment, API_BASE } from "../api";
```

2. Add new state alongside the existing `cases`/`results`/`loading` state:
```javascript
const [mode, setMode] = useState("single"); // "single" | "multi"
const [turns, setTurns] = useState([{ question: "", expected: "" }]);
```

3. Add turn-editing helpers, mirroring the existing case-editing helpers' shape exactly (find the existing `addCase`/`removeCase`/`updateCase`-style functions for the single-turn `cases` array and copy their pattern):
```javascript
const addTurn = () => setTurns((prev) => [...prev, { question: "", expected: "" }]);
const removeTurn = (index) => setTurns((prev) => prev.filter((_, i) => i !== index));
const updateTurn = (index, field, value) =>
  setTurns((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
```

4. Add a mode toggle in the JSX, near the existing provider checkboxes (find that block and add this alongside it):
```jsx
<div className="flex gap-2 mb-4">
  <button
    onClick={() => setMode("single")}
    className={`px-3 py-1.5 text-sm border ${mode === "single" ? "border-[var(--brand-primary)] text-[var(--brand-primary)]" : "border-[var(--border-subtle)] text-[var(--text-secondary)]"}`}
  >
    Single-turn
  </button>
  <button
    onClick={() => setMode("multi")}
    className={`px-3 py-1.5 text-sm border ${mode === "multi" ? "border-[var(--brand-primary)] text-[var(--brand-primary)]" : "border-[var(--border-subtle)] text-[var(--text-secondary)]"}`}
  >
    Multi-turn
  </button>
</div>
```

5. Add the multi-turn turn-editor JSX, rendered only when `mode === "multi"` (replacing the single-turn case list in that branch — find where the existing single-turn `cases.map(...)` editor renders and wrap both the existing single-turn block and this new one in a `{mode === "single" ? (...) : (...)}` conditional):
```jsx
{turns.map((t, i) => (
  <div key={i} className="flex gap-2 mb-2 items-start">
    <span className="text-xs text-[var(--text-muted)] mt-2 w-14 shrink-0">Turn {i + 1}</span>
    <input
      value={t.question}
      onChange={(e) => updateTurn(i, "question", e.target.value)}
      placeholder="Question"
      className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
    />
    <input
      value={t.expected}
      onChange={(e) => updateTurn(i, "expected", e.target.value)}
      placeholder="Expected keyword (optional)"
      className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
    />
    {turns.length > 1 && (
      <button onClick={() => removeTurn(i)} className="text-[var(--text-muted)] hover:text-[var(--brand-danger)] mt-2">
        ✕
      </button>
    )}
  </div>
))}
<button onClick={addTurn} className="text-sm text-[var(--brand-primary)] mb-4">
  + Add turn
</button>
```

- [ ] **Step 3: Wire the run button to branch on mode**

In `frontend/src/pages/Evaluation.jsx`, find the existing "run" handler (the function the "+ New Eval Run" / run button calls, which today loops `selectedProviders` × `cases` calling `runEvaluationOne`). Do NOT rewrite this function. Add exactly one new guard clause at its very top, before its existing first line, so multi-turn mode branches off into its own path and returns before any of the existing single-turn logic runs:

```javascript
if (mode === "multi") {
  setLoading(true);
  setError(null);
  const validTurns = turns.filter((t) => t.question.trim());
  if (validTurns.length === 0) {
    setLoading(false);
    return;
  }
  try {
    const conversation = await runEvaluationConversation(selectedProviders[0], validTurns.map((t) => ({
      question: t.question,
      expected: t.expected.trim() || null,
    })));
    setResults([conversation]);
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
    setProgress(null);
  }
  return;
}
```

Every line of the existing handler after this new guard clause — the entire single-turn path — stays byte-for-byte what it already is today.

- [ ] **Step 4: Display multi-turn results**

In `frontend/src/pages/Evaluation.jsx`, find where `results.map(...)` renders each result row in the results table/list. Do NOT rewrite that existing per-result JSX. A multi-turn result is distinguishable by having a `turns` array (a single-turn `EvalCaseResult` has no `turns` field at all, so `result.turns` is a clean discriminator). Wrap the existing single-turn row JSX in a ternary: keep the existing JSX completely unchanged as the `:` (else) branch, and add this as the new `?` (if) branch for when `r.turns` is present:

```jsx
<div className="border border-[var(--border-subtle)] p-3 mb-2">
  <div className="flex justify-between items-center mb-2">
    <span className="text-sm font-medium text-[var(--text-primary)]">{r.turns.length} turns · {r.provider}</span>
    <StatusPill status={r.passed ? "success" : "error"} label={r.passed ? "passed" : "failed"} />
  </div>
  {r.turns.map((t, ti) => (
    <div key={ti} className="text-xs text-[var(--text-secondary)] mb-1 pl-2 border-l border-[var(--border-subtle)]">
      <div><span className="text-[var(--text-muted)]">Turn {ti + 1}:</span> {t.question}</div>
      <div>{t.answer} {t.passed != null && (t.passed ? "✓" : "✕")}</div>
    </div>
  ))}
  {r.judge_notes && <div className="text-xs text-[var(--text-muted)] mt-2 italic">{r.judge_notes}</div>}
</div>
```

So the shape becomes `{r.turns ? (<the JSX above>) : (<the existing single-turn row JSX, completely unchanged>)}` inside the existing `results.map((r, i) => ( ... ))`.

- [ ] **Step 5: Manual smoke test**

Point `frontend/.env`'s `VITE_API_BASE` at `http://localhost:8010` (the local backend from Task 1), restart the Vite dev server, open the Evaluation Suite page:
- Default view (mode="single"): renders exactly as before, no console errors.
- Click "Multi-turn": the turn editor appears (starts with one empty turn row), single-turn case list disappears.
- Add 2-3 turns (e.g. the "my favorite color is teal" / "what is my favorite color" pair from Task 2's test), pick one provider, run it: a result card appears showing turn count, each turn's question/answer/pass mark, and the overall judge verdict.
- Switch back to "Single-turn": existing behavior still works exactly as before, no stale multi-turn state leaking in.
- Check the browser console for errors throughout. Restore `VITE_API_BASE` to the Render URL afterward and restart the Vite dev server again.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.js frontend/src/pages/Evaluation.jsx
git commit -m "Add multi-turn conversation UI to the Evaluation Suite"
```

---

### Critical Files for Implementation

- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\main.py` — new `TurnCase`/`TurnResult`/`EvalConversationRequest`/`ConversationResult` Pydantic schemas, `EvalCase.turns`/`ExperimentResultIn.turns` fields, `_judge_conversation`/`_run_multiturn_eval_case` functions, `POST /evaluation/run_conversation` endpoint
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\add_multiturn_evaluation.sql` — new migration (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\.github\workflows\eval.yml` — append the new migration to the ordered list
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\tests\test_multiturn_evaluation.py` — new test suite (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\pages\Evaluation.jsx` — mode toggle, turn editor, run wiring, results display
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\api.js` — new `runEvaluationConversation` function
