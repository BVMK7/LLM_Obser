# Multi-turn Evaluation — Design

## Context

This is the fourth and final sub-project of "Phase 5: advanced
evaluation" — Human Review, Custom Scorers, and Comparison/statistical
significance are all done and shipped. Today's Evaluation Suite
(`frontend/src/pages/Evaluation.jsx`, `POST /evaluation/run_one` /
`_run_eval_case` in `main.py`) is single-turn only: one question in, one
answer out, graded by an optional keyword match plus the built-in
LLM-judge and any selected custom Scorers. This sub-project extends
evaluation to fixed, scripted multi-turn conversations.

Four scope decisions, confirmed with the user before this was written:

- **Fixed script, not a dynamic simulated user.** All turns in a
  conversation are authored upfront by whoever builds the case (e.g.
  "Turn 1: what's my balance? Turn 2: transfer $50 to savings. Turn 3:
  confirm it went through"), each with its own optional expected
  keyword. Deterministic and repeatable, matching every other eval
  feature in this app — a dynamic simulated-user follow-up generator was
  explicitly declined as a separate, more complex direction.
- **Per-turn keyword match + one overall LLM-judge call**, not a judge
  call per turn. Each turn keeps today's cheap deterministic keyword
  check. Once the whole conversation finishes, exactly one judge call
  reads the full transcript and scores what's only visible across turns
  — context retention, overall task completion — rather than N
  disconnected per-turn judgments.
- **Extend `ExperimentResult`, don't create a parallel table.** One new
  nullable `turns` column holds the per-turn breakdown; the existing
  `question`/`answer`/`passed`/`scores` fields become the conversation's
  overall summary. A dedicated parallel model was explicitly declined —
  it would duplicate storage, comparison, and review-queue plumbing this
  feature gets for free by reusing `ExperimentResult`.
- **The provider-calling layer needs no changes.** `providers.py`'s
  `call_gemini`/`call_groq`/`call_openrouter` already accept a full
  `messages` list (`_normalize_messages` explicitly documents "so both
  single-turn and multi-turn callers work") — this was true before this
  sub-project existed and this design relies on it as-is.

Explicitly not addressed in this design (see "Explicitly out of scope"
at the end) rather than left ambiguous: custom Scorers on multi-turn
conversations, and saving/loading multi-turn cases via the Playground.

## Data model

**New Pydantic models** (`main.py`, alongside the existing `EvalCase` /
`EvalCaseResult` definitions):

```python
class TurnCase(BaseModel):
    question: str
    expected: Optional[str] = None


class TurnResult(BaseModel):
    question: str
    expected: Optional[str] = None
    answer: str
    passed: Optional[bool] = None
```

**`EvalCase` gains one new optional field**:

```python
class EvalCase(BaseModel):
    id: Optional[str] = None
    question: str
    expected: Optional[str] = None
    turns: Optional[list[TurnCase]] = None
```

When `turns` is set, the case *is* that sequence of turns — `question`/
`expected` on the case itself are unused (still required by the
Pydantic model for backward compatibility with every existing
single-turn caller, but ignored by any multi-turn code path). This is
the same model already embedded in `Dataset.cases` and used by
`POST /evaluation/run`, so a Dataset can hold a mix of single-turn and
multi-turn cases without any change to `Dataset`/`DatasetCreate`/
`DatasetResponse` themselves.

**`ExperimentResultIn`/`ExperimentResultResponse` gain one new optional
field**:

```python
turns: Optional[list[TurnResult]] = None
```

`null` for every existing single-turn row (past and future) — nothing
about a single-turn `ExperimentResult` changes. A multi-turn result
populates `turns` with the full per-turn breakdown and uses the
existing `question`/`answer`/`passed`/`scores` fields for the
conversation's overall summary: `question` = the first turn's question
(a stable, recognizable label in the Results table), `answer` = the
final turn's answer, `passed`/`scores` = the overall judge verdict (see
Grading below) — never a combination of per-turn keyword results.

**Migration** — new file `add_multiturn_evaluation.sql`, appended to the
ordered migration list in `.github/workflows/eval.yml` (after
`add_scorer_types.sql`, the current last entry):

```sql
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS turns JSONB;
```

## Execution flow

New function `_run_multiturn_eval_case(turns: list[TurnCase], provider: str, db: Session, project_id) -> ConversationResult`, mirroring `_run_eval_case`'s
overall shape:

1. Resolve `model_used = MODEL_CATALOG[provider]["default"]` (same as
   `_run_eval_case` — no model picker for multi-turn either, consistent
   with today's single-turn behavior).
2. Walk `turns` in order, accumulating a real OpenAI-style message
   history (`messages: list[dict]`, starting `[]`):
   - Append `{"role": "user", "content": turn.question}`.
   - Call `call_provider(messages, model=model_used)` — this is exactly
     the multi-turn path `_normalize_messages` already supports; no
     provider-layer changes.
   - On a per-turn exception, stop the loop immediately (don't attempt
     remaining turns against a conversation that's already broken) and
     return a `ConversationResult` right there — `turns` holding every
     turn completed so far plus this failed one
     (`TurnResult(question=turn.question, expected=turn.expected,
     answer=f"Error: {e}", passed=False)`), `passed=False`,
     `faithfulness`/`relevance`/`hallucination`/`judge_notes` all `None`
     (the judge never runs), `trace_id=None`. This exactly mirrors
     `_run_eval_case`'s own provider-exception branch, which also skips
     `_log_trace`/`_log_span` entirely and returns `trace_id=None` —
     one broken conversation shouldn't crash the whole eval run, and a
     partially-completed conversation isn't logged as if it were a real
     trace.
   - On success, append `{"role": "assistant", "content": answer}` to
     `messages` (so the NEXT turn's call sees this turn's real answer —
     this is what makes it genuinely multi-turn rather than N
     independent single-turn calls), and record this turn's keyword
     check: `passed = expected.strip().lower() in answer.lower() if
     (turn.expected and turn.expected.strip()) else None` — identical
     rule to today's single-turn `passed` computation.
3. If every turn succeeded, call the new `_judge_conversation(turn_results:
   list[TurnResult]) -> dict` (see Grading below) for the overall
   verdict.
4. Sum `input_tokens`/`output_tokens`/`total_tokens`/`cost` across every
   turn's provider call plus the judge call (`estimate_cost`, same
   helper `_run_eval_case` already uses). `latency_ms` sums each turn's
   call latency plus the judge call's latency (wall-clock per call, same
   `_timed_call` helper already used elsewhere in this file).
5. Once every turn succeeds and the judge call completes (the only path
   that reaches this step — see the per-turn exception handling above),
   log ONE `Trace` for the whole conversation via the existing
   `_log_trace` helper: `name=f"eval-conversation: {provider}"`,
   `input=turns[0].question`, `output=<final turn's answer>`,
   `started_at`=the first turn's call start, `ended_at`=the judge call's
   end (always the last thing to finish on this success path),
   `total_tokens`/`cost`/`model=model_used` as summed above.
6. Log one `Span` per turn via the existing `_log_span` helper
   (`step_name=f"turn_{i+1}"`, `input`/`output` = that turn's question/
   answer, `parent_span_id=None` — siblings directly under the trace,
   not nested under each other, since each turn's Span already carries
   its own place in `turns`' array order).
7. Log one more `Span` for the judge call, `step_name="judge:conversation"`,
   `input`=the full transcript, `output`=`json.dumps(judge_result)`,
   `parent_span_id=None` — a root-level sibling span, not nested under
   any one turn's span, since the judge reads the WHOLE conversation,
   not any single turn.

## Grading

New function `_judge_conversation(turn_results: list[TurnResult]) -> dict`,
mirroring `_judge_answer`'s existing fixed-judge-model convention (same
Groq call, same JSON-only response contract):

```python
def _judge_conversation(turn_results: list[TurnResult]) -> dict:
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
        # Same "a broken judge never breaks the eval run" fallback
        # _judge_answer uses -- passed=None here (not False) so a judge
        # outage is visibly distinct from a genuine failed conversation.
        return {"passed": None, "faithfulness": None, "relevance": None, "hallucination": None, "judge_notes": f"(judge failed: {e})"}
```

The `passed` field returned here — not any combination of per-turn
keyword results — becomes `ExperimentResult.passed` for the conversation
as a whole. This is the deliberate design point: a conversation can have
every individual turn's keyword check pass while still failing overall
(e.g. turn 3 forgets what turn 1 established), and the judge is what
catches that, since keyword matching a single turn's answer can't see
the rest of the conversation.

## New endpoint

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

Mirrors `POST /evaluation/run_one`'s existing shape exactly, at its own
path rather than an overloaded `EvalSingleRequest` — `turns` vs.
`question`/`expected` are different-enough request shapes that a single
endpoint branching on which fields are present would be more confusing
than two small, single-purpose endpoints.

## UI (`Evaluation.jsx`)

- A mode toggle in the case editor, alongside the existing provider
  checkboxes: **Single-turn** (today's UI, completely unchanged) vs.
  **Multi-turn** (a repeatable list of question/expected turn rows,
  reusing the exact add/remove-row pattern the existing cases list
  already has — "+ Add turn" / a remove button per row, at least one
  turn required).
- Running a multi-turn case calls `POST /evaluation/run_conversation`
  instead of `run_one`/`run_evaluation_one`'s existing per-provider-per-case
  loop; multi-turn cases only run against ONE provider per run (no
  provider-checkbox multi-select for multi-turn — matches how a
  conversation is a single continuous exchange, not something to
  compare providers on within one submit).
- Results table: a multi-turn result row shows a turn-count badge (e.g.
  "3 turns") instead of a single question/answer pair, expandable to
  show each turn's question/answer/passed plus the overall judge verdict
  and notes below it.
- The existing metric cards (Pass Rate, Cases Run, Avg Faithfulness,
  Hallucination Rate) require no changes — they already read the
  overall `passed`/`faithfulness`/`hallucination` fields off each
  result, which multi-turn results populate identically to single-turn
  ones.
- "Save as Experiment" (already existing) requires no changes either —
  it already just forwards each result's full JSON as one
  `ExperimentResultIn`, and `turns` rides along as an ordinary optional
  field.

## Explicitly out of scope for this turn

- **Custom Scorers on multi-turn conversations.** Today's single-turn
  path lets you select custom Scorers (pattern-match, JSON-valid,
  LLM-judge) alongside the built-in judge. Wiring custom Scorers into a
  multi-turn conversation (per-turn? once over the transcript?) is a
  real, separate design question not resolved here — multi-turn
  conversations only ever get the one built-in `_judge_conversation`
  call for this cut.
- **Saving/loading multi-turn cases through the Playground or as a
  dataset default.** `Dataset.cases` technically already supports
  holding a `turns`-shaped `EvalCase` (no schema change needed, per the
  data model above), but building/testing that save/load path through
  the UI is not part of this cut — only ad-hoc multi-turn runs from the
  Evaluation Suite's own case editor.
- **A dynamic/simulated-user turn generator.** Explicitly declined in
  favor of fixed, author-written scripts (see Context).
- **Per-provider comparison within one multi-turn submit.** A multi-turn
  run targets exactly one provider per submit, unlike single-turn's
  multi-provider checkbox row.

## Testing plan

New `tests/test_multiturn_evaluation.py`, same live-server convention as
every other suite in this repo:

- A 2-3 turn conversation where every turn's answer is predictable and
  correct: each turn's `passed` is `True`, the overall `passed` is
  `True`, and `trace_id` resolves to a real `Trace` with one `Span` per
  turn plus a `judge:conversation` span.
- A conversation that specifically proves context carries across turns
  — e.g. turn 1 states a fact ("my name is Alex"), turn 2 asks the
  model to recall it ("what's my name?") with `expected="Alex"` — to
  prove `messages` genuinely accumulates prior turns rather than each
  turn being called in isolation.
- A single turn's keyword mismatch is recorded as `passed=False` on
  that turn specifically, without necessarily failing every other
  turn's own `passed` value.
- A conversation with no `expected` set on any turn: every turn's
  `passed` is `None` (never `False` from a missing keyword — same "no
  keyword provided" contract as single-turn), while the overall judge
  `passed` can still be `True`/`False`.
- Saving a multi-turn `ConversationResult` as an `ExperimentResult` via
  `POST /experiments` round-trips `turns` correctly (the new JSONB
  column holds and returns the full per-turn breakdown).
- An invalid `provider` (or another provider-call failure) on, say, the
  second turn of a 3-turn conversation returns `passed=False`,
  `trace_id=None`, and `turns` containing exactly the completed first
  turn plus the failed second turn — never a third turn, and never a
  500.
- Existing `tests/test_scorer_types.py`/other single-turn evaluation
  tests continue to pass unmodified — this feature is additive only.
