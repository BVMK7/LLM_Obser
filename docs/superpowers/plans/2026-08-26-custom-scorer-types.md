# Custom Deterministic Scorer Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

This is the second of four independent sub-projects that make up "Phase 5: advanced evaluation" (build order confirmed with the user: Human review [done] → Custom scorers [this plan] → Comparison/statistical significance → Multi-turn evaluation). The Evaluation system's `Scorer` model today is implicitly a single type — every scorer is an LLM-judge rubric: a `prompt_template` filled with `{{input}}/{{output}}/{{expected}}`, sent to Groq, whose response is mapped through `choice_scores` to a 0-1 float. This plan adds two **deterministic, non-LLM** scorer types alongside it: `pattern_match` (regex or substring match against the answer) and `json_valid` (does the answer parse as JSON via stdlib `json.loads`). Composite/combined scorers are explicitly out of scope for this pass.

Two design facts drive the whole shape of this plan:

- **`prompt_template`/`choice_scores` must become nullable columns.** They are `NOT NULL` today because every scorer used to be an LLM judge. A `pattern_match`/`json_valid` scorer has no prompt and no label→score mapping, so at the DB level these two columns simply don't apply to it. The per-type "this field is required for this type" rule is enforced at the Pydantic layer (a `model_validator` on `ScorerCreate`), not a DB constraint — this table predates `scorer_type`, and `ALTER TABLE ... ADD CONSTRAINT` is not safely re-runnable (a second run errors "constraint already exists"), which would break this repo's hard idempotency requirement for migrations. `ALTER COLUMN ... DROP NOT NULL`, by contrast, is naturally idempotent (a second run against an already-nullable column is a silent no-op).
- **`_run_custom_scorer` is the single shared scoring function** — called from exactly three places: eval-case scoring (`main.py:3389`, inside `_run_eval_case`), the online-scoring background loop (`main.py:3305`, inside `_run_online_scoring_once`), and guardrail checks (`main.py:3049`, inside `check_guardrail`). Adding a `scorer.scorer_type` dispatch inside this one function automatically covers all three call sites — evaluation, online scoring, and guardrails all get pattern-match/JSON-valid scoring for free, with zero changes to any of those three call sites. Every scorer function (existing and new) must keep returning the exact same `{"label": str|None, "score": float|None, "explanation": str}` shape, since all three call sites branch on `result["score"] is None`.

## Global Constraints

- No new pip dependency. `json_valid` uses only the stdlib `json` module (already imported in `main.py`); `pattern_match` uses only the stdlib `re` module (already imported).
- Every scorer function (`_run_custom_scorer`'s existing LLM-judge branch, and the two new `_run_pattern_match_scorer`/`_run_json_valid_scorer` functions) must return exactly `{"label": ..., "score": ..., "explanation": ...}` — never a differently-shaped dict, since all three call sites (`_run_eval_case`, `_run_online_scoring_once`, `check_guardrail`) depend on this exact shape.
- No DB-level CHECK constraint. Per-type field requirements (`prompt_template`+`choice_scores` required when `scorer_type == "llm_judge"`, `pattern` required when `scorer_type == "pattern_match"`) are enforced only via a Pydantic `model_validator` on `ScorerCreate`.
- `ALTER COLUMN ... DROP NOT NULL` is naturally idempotent — no `IF EXISTS`/guard needed for it, unlike `ADD COLUMN` (which still needs `IF NOT EXISTS`) or `ADD CONSTRAINT` (which is never safely re-runnable and must not be used here).
- The three exact string values are `"llm_judge"`, `"pattern_match"`, `"json_valid"` — used verbatim in the Pydantic `Literal[...]`, the DB column default, and the frontend `<select>` option values. Never invent alternate spellings/casings.
- `pattern_is_regex: bool = False` is the exact field name for the regex-vs-substring toggle on `pattern_match` scorers.
- Every new scorer function must tolerate `answer` being `None` without raising — `_run_json_valid_scorer` already does (its `except` clause catches `TypeError`, which is what `json.loads(None)` raises), but `_run_pattern_match_scorer` must explicitly guard against it too (`answer = answer or ""` before use), since its `except` clause only catches `re.error` and a bare `scorer.pattern in None` would otherwise raise an uncaught `TypeError` that could 500 the eval-run endpoint rather than degrading gracefully like every other failure mode in this function.
- Not building composite/combined scorers, JSON Schema validation, or any new pip dependency — all explicitly declined for this pass.
- Migrations are plain root-level `.sql` files, idempotent, applied via `.github/workflows/eval.yml`'s hardcoded ordered list — the last entry today is `add_experiment_result_review.sql`.
- This repo's only testing convention is live-server integration tests over real HTTP (`tests/conftest.py`'s fixtures, unchanged).
- Nothing pushed to `origin/main` until the user says so — commit locally only.

---

### Task 1: Migration + `Scorer` model

**Files:**
- Create: `add_scorer_types.sql`
- Modify: `.github/workflows/eval.yml` (migration list)
- Modify: `main.py` — `Scorer` model (`main.py:451-471`)

**Interfaces:**
- Produces: `scorers.scorer_type` (TEXT, default `'llm_judge'`), `scorers.pattern` (TEXT, nullable), `scorers.pattern_is_regex` (BOOLEAN, default `false`); `scorers.prompt_template`/`scorers.choice_scores` become nullable. Task 2's schemas/dispatch and Task 3's tests both consume these exact column/attribute names.

- [ ] **Step 1: Write the migration**

```sql
-- add_scorer_types.sql
-- Deterministic (non-LLM) scorer types alongside the existing implicit
-- LLM-judge scorer type: pattern_match (regex or substring match against a
-- Scorer's output) and json_valid (does the output parse as valid JSON via
-- Python's stdlib json.loads -- no JSON Schema validation). See
-- _run_custom_scorer's scorer_type dispatch in main.py.
--
-- prompt_template/choice_scores were NOT NULL because every scorer used to
-- be an LLM judge; a pattern_match/json_valid scorer has no prompt and no
-- choice-label mapping, so those two columns must become nullable at the
-- DB level. The per-type "this field is required for this type" rule is
-- enforced at the Pydantic layer (ScorerCreate.model_validator in main.py),
-- not a DB CHECK constraint -- this table predates scorer_type, and
-- ALTER TABLE ... ADD CONSTRAINT is not safely re-runnable (a second run
-- errors "constraint already exists"), which would break this repo's hard
-- idempotency requirement for migrations. DROP NOT NULL, by contrast, is
-- naturally idempotent: running it twice against an already-nullable
-- column is a silent no-op.

ALTER TABLE scorers ALTER COLUMN prompt_template DROP NOT NULL;
ALTER TABLE scorers ALTER COLUMN choice_scores DROP NOT NULL;
ALTER TABLE scorers ADD COLUMN IF NOT EXISTS scorer_type TEXT NOT NULL DEFAULT 'llm_judge';
ALTER TABLE scorers ADD COLUMN IF NOT EXISTS pattern TEXT;
ALTER TABLE scorers ADD COLUMN IF NOT EXISTS pattern_is_regex BOOLEAN NOT NULL DEFAULT false;
```

Apply it to the local dev Postgres the same way every other migration this session was applied:
```
docker exec -i llm-observability-db psql -U llm_observability -d llm_observability -f - < add_scorer_types.sql
```
Confirm all five `ALTER TABLE` statements succeed, then re-run the same command a second time to confirm idempotency (no errors — `DROP NOT NULL` is a no-op on an already-nullable column, and the `ADD COLUMN IF NOT EXISTS` statements are unchanged from the existing convention). Separately confirm existing rows backfilled correctly: `SELECT scorer_type, pattern_is_regex FROM scorers;` should show every pre-existing row as `llm_judge` / `false` (Postgres backfills existing rows when you `ADD COLUMN ... NOT NULL DEFAULT ...`), which is exactly what Task 3's backward-compatibility test asserts end-to-end.

- [ ] **Step 2: Add it to the CI migration list**

In `.github/workflows/eval.yml`, the line ending `...add_data_retention.sql add_otel_export.sql add_experiment_result_review.sql; do` becomes:
```
...add_data_retention.sql add_otel_export.sql add_experiment_result_review.sql add_scorer_types.sql; do
```

- [ ] **Step 3: Update the `Scorer` model**

In `main.py`, replace the `Scorer` class body (`main.py:451-471`) with:

```python
class Scorer(Base):
    __tablename__ = "scorers"
    # Slug only has to be unique within a project — two different customers
    # can each have their own "correctness" scorer without colliding.
    __table_args__ = (UniqueConstraint("project_id", "slug", name="uq_scorers_project_slug"),)

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    slug = Column(String, nullable=False)
    description = Column(Text)
    # "llm_judge" (default, existing behavior), "pattern_match", or
    # "json_valid" — see _run_custom_scorer's dispatch below. Only
    # semantically required for its own type; per-type requirements are
    # enforced in ScorerCreate's model_validator, not here.
    scorer_type = Column(String, nullable=False, server_default="llm_judge")
    # Only meaningful (and only Pydantic-required) when scorer_type ==
    # "llm_judge" — nullable since a deterministic scorer has neither.
    prompt_template = Column(Text)
    choice_scores = Column(JSONB, server_default="{}")
    # Only meaningful (and only Pydantic-required) when scorer_type ==
    # "pattern_match" — the regex or substring to look for in the answer.
    pattern = Column(Text)
    pattern_is_regex = Column(Boolean, nullable=False, server_default="false")
    pass_threshold = Column(Numeric, nullable=False, server_default="0.5")
    # Opt-in continuous scoring: when true, _online_scoring_loop runs this
    # scorer against new traces automatically (see below). Opt-in, not
    # automatic for every scorer, since that would be an uncontrolled LLM
    # cost — off by default.
    run_online = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default="now()", onupdate=func.now())
```

- [ ] **Step 4: Verify**

`python -m py_compile main.py && python -c "import main"` — clean, no traceback. Restart the local backend (kill whatever's on port 8010, `python -m uvicorn main:app --port 8010`), confirm `GET /docs` returns 200. `GET /scorers` against a project with pre-existing scorers should still return 200 with the existing scorers intact (the model change alone doesn't touch `ScorerResponse` yet, so this just confirms the model/DB shape is consistent — full end-to-end verification happens after Task 2).

- [ ] **Step 5: Commit**

```bash
git add add_scorer_types.sql .github/workflows/eval.yml main.py
git commit -m "Add scorer_type/pattern columns to scorers table"
```

---

### Task 2: Pydantic schemas, scorer functions, dispatch, and endpoints

**Files:**
- Modify: `main.py` — pydantic import (`main.py:26`), `ScorerCreate`/`ScorerResponse` (`main.py:1006-1021`), `_run_custom_scorer` and its new sibling functions (`main.py:2978-3006`), `create_scorer`/`update_scorer` (`main.py:3512-3557`)

**Interfaces:**
- Consumes: Task 1's `scorer_type`/`pattern`/`pattern_is_regex` columns.
- Produces: `POST/PUT /scorers` accepting and validating the three scorer types; `_run_custom_scorer` transparently dispatching to the right scoring logic for all three of its call sites. Task 3's tests and Task 4's frontend both consume the exact field names `scorer_type`, `pattern`, `pattern_is_regex` on `ScorerResponse`.

- [ ] **Step 1: Import `model_validator`**

In `main.py:26`, change:
```python
from pydantic import BaseModel, ConfigDict, Field, field_validator
```
to:
```python
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
```

- [ ] **Step 2: Update `ScorerCreate`/`ScorerResponse`**

Replace `main.py:1000-1021` with:

```python
# ScorerCreate/Update — a user-defined scoring rule. Three types:
#   - "llm_judge" (default, existing behavior): `prompt_template` may
#     reference {{input}}, {{output}}, {{expected}} — substituted at run
#     time. `choice_scores` maps the judge's chosen label to a 0-1 score,
#     e.g. {"Yes": 1.0, "Partially": 0.5, "No": 0.0} (mirrors Braintrust's
#     "choice scores" concept: a judge picks a label, not a raw float,
#     which is far more reliable to parse out of an LLM response than
#     asking it for a bare number).
#   - "pattern_match": deterministic, no LLM call — scores 1.0 if `pattern`
#     is found in the answer (regex `re.search` when `pattern_is_regex`,
#     otherwise a plain substring check), else 0.0.
#   - "json_valid": deterministic, no LLM call — scores 1.0 if the answer
#     parses as JSON via `json.loads`, else 0.0. No JSON Schema validation.
class ScorerCreate(BaseModel):
    name: str
    description: Optional[str] = None
    scorer_type: Literal["llm_judge", "pattern_match", "json_valid"] = "llm_judge"
    # Required (non-None) only when scorer_type == "llm_judge" — see the
    # model_validator below. Nullable here (not a plain `str`) because a
    # pattern_match/json_valid scorer has no prompt at all.
    prompt_template: Optional[str] = None
    choice_scores: Optional[dict[str, float]] = None
    # Required (non-empty) only when scorer_type == "pattern_match".
    pattern: Optional[str] = None
    pattern_is_regex: bool = False
    pass_threshold: float = 0.5
    run_online: bool = False

    @model_validator(mode="after")
    def _validate_type_specific_fields(self):
        if self.scorer_type == "llm_judge":
            if self.prompt_template is None or not self.prompt_template.strip():
                raise ValueError("prompt_template is required when scorer_type is 'llm_judge'")
            if self.choice_scores is None:
                raise ValueError("choice_scores is required when scorer_type is 'llm_judge'")
        elif self.scorer_type == "pattern_match":
            if self.pattern is None or not self.pattern.strip():
                raise ValueError("pattern is required when scorer_type is 'pattern_match'")
        # "json_valid" needs none of prompt_template/choice_scores/pattern.
        return self


class ScorerResponse(ScorerCreate):
    id: uuid.UUID
    slug: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

Note: `ScorerResponse` inherits `_validate_type_specific_fields` from `ScorerCreate` since it's a subclass, so `GET`/`GET {id}`/`POST`/`PUT` responses are all validated the same way on the way out, not just requests on the way in. This is safe for every pre-existing row: pre-migration, `prompt_template`/`choice_scores` were `NOT NULL` at the DB level, so no existing `llm_judge` row can have a `None` value for either — the validator's `is None` checks (deliberately not `not self.prompt_template`/falsy checks, which would also reject a legitimately-empty-but-present `choice_scores: {}`) can never fire for data that predates this migration.

- [ ] **Step 3: Add the two deterministic scorer functions and dispatch in `_run_custom_scorer`**

Replace `main.py:2978-3006` with:

```python
_SCORER_PLACEHOLDERS = re.compile(r"\{\{(input|output|expected)\}\}")


# Deterministic, no LLM call: does `answer` match scorer.pattern? Regex
# (re.search) when pattern_is_regex, else a plain substring check. Score is
# always 1.0 (match) or 0.0 (no match) — there's no partial-credit concept
# for a deterministic check, unlike an LLM judge's label→score mapping. An
# invalid regex (bad pattern_is_regex=True pattern) fails gracefully with
# score=None, the same shape _run_custom_scorer's own except block returns,
# rather than raising and 500ing the caller. `answer` is coerced to a plain
# string first so a None answer (however unlikely from a real provider
# response) can never raise a TypeError out of this function the way a bare
# `scorer.pattern in None` would.
def _run_pattern_match_scorer(scorer: "Scorer", answer: str) -> dict:
    answer = answer or ""
    try:
        if scorer.pattern_is_regex:
            matched = re.search(scorer.pattern, answer) is not None
        else:
            matched = scorer.pattern in answer
    except re.error as e:
        return {"label": None, "score": None, "explanation": f"(invalid regex: {e})"}
    score = 1.0 if matched else 0.0
    label = "match" if matched else "no_match"
    mode = "regex" if scorer.pattern_is_regex else "substring"
    return {
        "label": label,
        "score": score,
        "explanation": f"{mode} pattern {scorer.pattern!r} {'matched' if matched else 'did not match'} the output",
    }


# Deterministic, no LLM call: does `answer` parse as valid JSON via the
# stdlib json module? Purely a parse success/failure check — no JSON Schema
# validation of the parsed structure's shape. json.loads(None) raises
# TypeError (not JSONDecodeError), which is why both exception types are
# caught below — a None answer degrades to score=0.0 like any other
# not-valid-JSON answer, rather than raising.
def _run_json_valid_scorer(answer: str) -> dict:
    try:
        json.loads(answer)
    except (json.JSONDecodeError, TypeError) as e:
        return {"label": "invalid_json", "score": 0.0, "explanation": f"output is not valid JSON: {e}"}
    return {"label": "valid_json", "score": 1.0, "explanation": "output parsed as valid JSON"}


# Runs one user-defined Scorer against one (question, answer, expected)
# triple. Dispatches on scorer.scorer_type:
#   - "pattern_match"/"json_valid": deterministic, handled above, no LLM call.
#   - "llm_judge" (default, and the only type before this dispatch existed):
#     substitutes {{input}}/{{output}}/{{expected}} into the scorer's own
#     prompt template, asks Groq (same fixed-judge convention as
#     _judge_answer) to respond with ONLY the chosen label, then maps that
#     label to a 0-1 score via the scorer's choice_scores. An unrecognized/
#     unparseable label returns score=None rather than guessing.
# Every branch returns the exact same {"label", "score", "explanation"}
# shape — all three call sites (eval-case scoring, online scoring,
# guardrail checks) depend on it.
def _run_custom_scorer(scorer: "Scorer", question: str, answer: str, expected: Optional[str]) -> dict:
    if scorer.scorer_type == "pattern_match":
        return _run_pattern_match_scorer(scorer, answer)
    if scorer.scorer_type == "json_valid":
        return _run_json_valid_scorer(answer)

    call_groq = PROVIDERS["groq"]
    values = {"input": question, "output": answer, "expected": expected or "(none provided)"}
    # A single regex pass over the ORIGINAL template — substituting only the
    # placeholders that were actually written there — so if `question` or
    # `answer` itself contains literal text like "{{output}}" (e.g. a
    # question about templating syntax), that text is never re-substituted
    # by a later step the way chained str.replace() calls would.
    filled = _SCORER_PLACEHOLDERS.sub(lambda m: values[m.group(1)], scorer.prompt_template)
    choices = list(scorer.choice_scores.keys())
    prompt = (
        f"{filled}\n\n"
        f"Respond with ONLY one of these exact labels, nothing else: {', '.join(choices)}"
    )
    try:
        raw, _input_tokens, _output_tokens = call_groq(prompt)
        label = raw.strip().strip('"').strip(".")
        # Exact match first, then a tolerant substring match (judges sometimes
        # wrap the label in a short sentence despite the instruction above).
        if label not in scorer.choice_scores:
            label = next((c for c in choices if c.lower() in raw.lower()), None)
        if label is None:
            return {"label": None, "score": None, "explanation": f"(unrecognized judge response: {raw[:120]})"}
        return {"label": label, "score": float(scorer.choice_scores[label]), "explanation": raw.strip()}
    except Exception as e:
        return {"label": None, "score": None, "explanation": f"(scorer failed: {e})"}
```

Nothing else changes: `_run_eval_case` (`main.py:3389`), `_run_online_scoring_once` (`main.py:3305`), and `check_guardrail` (`main.py:3049`) all call `_run_custom_scorer(scorer, ...)` exactly as before and get the right behavior automatically based on the `Scorer` row's `scorer_type`.

- [ ] **Step 4: Wire the endpoints**

`create_scorer` (`main.py:3512-3532`) needs **no changes** — it already builds the row generically via `Scorer(project_id=project.id, slug=slug, **scorer.model_dump())`, and `scorer_type`/`pattern`/`pattern_is_regex` now exist with matching names on both `ScorerCreate` and `Scorer`, so they flow through for free.

`update_scorer` (`main.py:3543-3557`) sets fields explicitly one-by-one, so it needs the three new fields added or it will silently ignore them. Replace its body from `db_scorer.name = scorer.name` through `db_scorer.run_online = scorer.run_online` with:

```python
    db_scorer.name = scorer.name
    db_scorer.description = scorer.description
    db_scorer.scorer_type = scorer.scorer_type
    db_scorer.prompt_template = scorer.prompt_template
    db_scorer.choice_scores = scorer.choice_scores
    db_scorer.pattern = scorer.pattern
    db_scorer.pattern_is_regex = scorer.pattern_is_regex
    db_scorer.pass_threshold = scorer.pass_threshold
    db_scorer.run_online = scorer.run_online
```

- [ ] **Step 5: Verify**

`python -m py_compile main.py && python -c "import main"` — clean. Restart the local backend. Manually exercise all three types against the running backend with `curl`/the FastAPI `/docs` Swagger UI:
- `POST /scorers` with `scorer_type: "pattern_match"`, `pattern: "hello"` → 200, response includes `scorer_type`/`pattern`/`pattern_is_regex`.
- `POST /scorers` with `scorer_type: "llm_judge"` and no `prompt_template` → 422.
- `POST /scorers` with `scorer_type: "json_valid"` (no `pattern`, no `prompt_template`, no `choice_scores`) → 200.
- `GET /scorers` on a project with a pre-existing (pre-migration-shape) scorer still returns 200 with `scorer_type: "llm_judge"` populated on it.

- [ ] **Step 6: Commit**

```bash
git add main.py
git commit -m "Add pattern_match and json_valid deterministic scorer types"
```

---

### Task 3: Test suite

**Files:**
- Create: `tests/test_scorer_types.py`

**Interfaces:**
- Consumes: `project`, `api_headers` fixtures (existing, `tests/conftest.py`, unchanged); `POST /scorers`, `POST /evaluation/run_one` from Task 2.

- [ ] **Step 1: Write the tests** (live-server convention, same `_post`/`_get` helper shape as `tests/test_phase2_operational.py`)

```python
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
```

If any test using the real Groq answer/judge round-trip flakes on exact wording during your first run, adjust only the *question wording* to make the model's likely answer more predictable — never relax the assertions themselves (the assertions must stay on `scorer_scores`/status-code shape, which is what's actually under test).

- [ ] **Step 2: Run and fix**

`python -m pytest tests/test_scorer_types.py -v` — iterate until green.

- [ ] **Step 3: Full regression run**

Run the full suite properly tracked in the background (never a manually-tailed redirected log — this repo has been repeatedly bitten by Windows stdout buffering making a genuinely-running process look stalled): `python -u -m pytest tests/ -v`. Confirm all pre-existing tests plus the new ones pass. Wait for actual completion.

- [ ] **Step 4: Commit**

```bash
git add tests/test_scorer_types.py
git commit -m "Add test suite for pattern_match and json_valid scorer types"
```

---

### Task 4: Frontend UI

**Files:**
- Modify: `frontend/src/pages/Scorers.jsx`

**Interfaces:**
- Consumes: `scorer_type`/`pattern`/`pattern_is_regex` fields from Task 2's `ScorerResponse`, via the existing `getScorers`/`getScorer`/`createScorer`/`updateScorer` functions in `frontend/src/api.js` (unchanged — they already pass whatever payload shape the caller gives them, per `frontend/src/api.js:235-239`).

- [ ] **Step 1: Add a type selector and guard the existing null-unsafe reads**

In `frontend/src/pages/Scorers.jsx`:

1. `draftScorer()` (lines 10-22) gains the three new fields, so a brand-new scorer defaults to today's behavior:
```javascript
function draftScorer() {
  return {
    id: null,
    name: "New Scorer",
    description: "",
    scorer_type: "llm_judge",
    prompt_template: "Question: {{input}}\nExpected: {{expected}}\nAnswer: {{output}}\n\n<criteria to judge>",
    choices: [
      { id: crypto.randomUUID(), label: "Yes", value: 1.0 },
      { id: crypto.randomUUID(), label: "No", value: 0.0 },
    ],
    pattern: "",
    pattern_is_regex: false,
    pass_threshold: 0.7,
  };
}
```

2. `selectScorer`'s `.then((data) => ...)` (line 103) currently does `choiceScoresToChoices(data.choice_scores)`, which throws (`Object.entries(null)`) for a `pattern_match`/`json_valid` scorer whose `choice_scores` is `null`. Change it to:
```javascript
setDetail({ ...data, choices: choiceScoresToChoices(data.choice_scores || {}) });
```

3. The sidebar list item's secondary line (lines 227-229) currently does `Object.keys(s.choice_scores).length}` unconditionally, which throws the same way for a non-`llm_judge` scorer in the list. Replace that line with:
```jsx
<div className={`text-xs mt-0.5 ${s.id === selectedId ? "text-white/70" : "text-[var(--text-muted)]"}`}>
  {s.scorer_type === "llm_judge"
    ? `${Object.keys(s.choice_scores || {}).length} choices`
    : s.scorer_type === "pattern_match"
    ? "pattern match"
    : "JSON validity"}
  {" · "}
  {formatTimestamp(s.updated_at)}
</div>
```

- [ ] **Step 2: Render the type dropdown and conditional fields**

Right after the description `<input>` block (after line 257, before the `<div className="flex gap-2 shrink-0">` actions block, or immediately above the "Judge Prompt" heading at line 278 — place it directly above the "Judge Prompt" heading so it visually introduces the type-dependent section below it) add:

```jsx
<div className="mb-4">
  <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Scorer Type</label>
  <select
    value={detail.scorer_type}
    onChange={(e) => updateField("scorer_type", e.target.value)}
    className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
  >
    <option value="llm_judge">LLM Judge</option>
    <option value="pattern_match">Pattern Match</option>
    <option value="json_valid">JSON Valid</option>
  </select>
</div>
```

Then wrap the existing "Judge Prompt" + "Choice Scores" blocks (lines 278-324) in a conditional:

```jsx
{detail.scorer_type === "llm_judge" && (
  <>
    <div className="text-sm font-medium text-[var(--text-primary)] mb-2">Judge Prompt</div>
    <textarea
      value={detail.prompt_template}
      onChange={(e) => updateField("prompt_template", e.target.value)}
      rows={6}
      placeholder="Use {{input}}, {{output}}, {{expected}} as placeholders"
      className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--brand-primary)] mb-4"
    />

    <div className="text-sm font-medium text-[var(--text-primary)] mb-2">
      Choice Scores ({detail.choices.length})
    </div>
    <div className="flex flex-col gap-2 mb-3">
      {detail.choices.map((c) => (
        <div key={c.id} className="flex gap-2 items-center">
          <input
            value={c.label}
            onChange={(e) => updateChoiceLabel(c.id, e.target.value)}
            placeholder="Label the judge must respond with"
            className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <input
            type="number"
            min="0"
            max="1"
            step="0.1"
            value={c.value}
            onChange={(e) => updateChoiceValue(c.id, Number(e.target.value))}
            className="w-24 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <button
            onClick={() => removeChoice(c.id)}
            disabled={detail.choices.length === 1}
            className="px-2 py-2 text-[var(--text-muted)] hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Remove choice"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
    <button
      onClick={addChoice}
      className="px-3 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] text-sm hover:bg-white/10 transition-colors mb-4"
    >
      + Add choice
    </button>
  </>
)}

{detail.scorer_type === "pattern_match" && (
  <div className="mb-4">
    <div className="text-sm font-medium text-[var(--text-primary)] mb-2">Pattern</div>
    <input
      value={detail.pattern}
      onChange={(e) => updateField("pattern", e.target.value)}
      placeholder={detail.pattern_is_regex ? "Regex pattern, e.g. ^\\d+$" : "Substring to look for in the output"}
      className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--brand-primary)] mb-2"
    />
    <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <input
        type="checkbox"
        checked={detail.pattern_is_regex}
        onChange={(e) => updateField("pattern_is_regex", e.target.checked)}
      />
      Treat pattern as a regular expression
    </label>
  </div>
)}

{detail.scorer_type === "json_valid" && (
  <div className="mb-4 text-sm text-[var(--text-muted)]">
    No extra configuration — the output is scored 1.0 if it parses as valid JSON, 0.0 otherwise.
  </div>
)}
```

- [ ] **Step 3: Update `handleSave` and the Save button's disabled condition**

Replace `handleSave` (lines 152-179) with:

```javascript
const handleSave = async () => {
  setSaving(true);
  setError(null);
  try {
    const payload = {
      name: detail.name,
      description: detail.description || null,
      scorer_type: detail.scorer_type,
      pass_threshold: Number(detail.pass_threshold),
    };
    if (detail.scorer_type === "llm_judge") {
      const { map: choice_scores, error: choicesError } = choicesToMap(detail.choices);
      if (choicesError) {
        setError(choicesError);
        setSaving(false);
        return;
      }
      payload.prompt_template = detail.prompt_template;
      payload.choice_scores = choice_scores;
    } else if (detail.scorer_type === "pattern_match") {
      payload.pattern = detail.pattern;
      payload.pattern_is_regex = detail.pattern_is_regex;
    }
    const saved = detail.id ? await updateScorer(detail.id, payload) : await createScorer(payload);
    currentIdRef.current = saved.id;
    setSelectedId(saved.id);
    setDetail({ ...saved, choices: choiceScoresToChoices(saved.choice_scores || {}) });
    setDirty(false);
    await refreshList();
  } catch (err) {
    setError(err.message);
  } finally {
    setSaving(false);
  }
};
```

Then update the Save button's `disabled` condition (line 270) — `detail.choices.length === 0` only matters for `llm_judge`:
```jsx
disabled={saving || !detail.name.trim() || (detail.scorer_type === "llm_judge" && detail.choices.length === 0)}
```

(Backend-side validation of `pattern` non-empty for `pattern_match` is still enforced server-side by `ScorerCreate`'s `model_validator` — a 422 surfaces through `request()`'s generic `errorMessage` string exactly as every other endpoint in this app already does, no special-casing needed here.)

- [ ] **Step 4: Manual smoke test**

Point `frontend/.env`'s `VITE_API_BASE` at `http://localhost:8010` (the local backend from Tasks 1-2), restart the Vite dev server, open the Scorers page:
- Create a new `pattern_match` scorer with `pattern: "yes"`, save it, reload the page, confirm the type/pattern/checkbox persisted.
- Switch an existing `llm_judge` scorer's type to `json_valid` in the dropdown, confirm the Judge Prompt/Choice Scores fields disappear, save, reload, confirm it still shows as `json_valid` with no crash reading `choice_scores`.
- Confirm the scorer list sidebar renders correctly for a mix of all three types (no console errors from `Object.keys(null)`/`Object.entries(null)`).
- Check the browser console for errors throughout. Restore `VITE_API_BASE` to the Render URL afterward and restart the Vite dev server again.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Scorers.jsx
git commit -m "Add scorer type selector and pattern_match/json_valid fields to Scorers UI"
```

---

### Critical Files for Implementation

- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\main.py` — `Scorer` model, `ScorerCreate`/`ScorerResponse` schemas, `_run_custom_scorer` dispatch + new `_run_pattern_match_scorer`/`_run_json_valid_scorer` functions, `create_scorer`/`update_scorer` endpoints
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\add_scorer_types.sql` — new migration (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\.github\workflows\eval.yml` — CI migration list ordering
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\tests\test_scorer_types.py` — new test suite (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\pages\Scorers.jsx` — type selector, conditional fields, null-safety fixes for non-`llm_judge` scorers
