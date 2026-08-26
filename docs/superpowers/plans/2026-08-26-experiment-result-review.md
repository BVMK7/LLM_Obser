# Human-in-the-Loop Experiment Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

This is the first of four independent sub-projects that make up "Phase 5: advanced evaluation" (build order confirmed with the user: Human review → Custom scorers → Comparison/statistical significance → Multi-turn evaluation). This app already has an Evaluation/Experiment system (`Dataset`, `Scorer`, `Experiment`, `ExperimentResult` in `main.py`), but a research pass confirmed the entire surface is **read-only display of automated judgments** today — `ExperimentResult` has no column for human feedback of any kind, and neither `Evaluation.jsx` (the live run page) nor `ExperimentDetail.jsx` (the saved-experiment view) has any control for a human to react to an individual result.

This plan adds the simplest possible human calibration signal: a reviewer can mark whether they **agree or disagree** with the automated verdict on a saved `ExperimentResult`. Two decisions were confirmed with the user before this was written:

- **Agree/disagree only** — no free-text note field, and the human verdict does not overwrite the automated `passed`/`scores` values. This is a calibration signal sitting alongside the automated judgment, not a replacement for it.
- **Direct nullable columns on `ExperimentResult`**, not a separate append-only event table. Each result gets reviewed once (there's no need to preserve a history of changing opinions the way `TraceFlag` needs to preserve a history of open/resolved safety flags), so this follows this app's simpler "nullable column on the row = optional human input" pattern (e.g. `Trace.review_note`), not the `TraceFlag` precedent.

**No `reviewed_by` field.** A research pass over the existing "human resolves something in the dashboard" precedent (`PATCH /traces/{trace_id}/flags/{flag_id}`, the Review Queue's flag-resolution endpoint) confirmed it does **not** attribute the action to a specific logged-in user either — like every other Experiments/Review endpoint, it authenticates via the project's API key (`Project = Depends(get_current_project)`), not a human login session (`User = Depends(get_current_user)`), because the dashboard's data-plane calls all go through the API-key-authenticated client. Adding per-user attribution here would be a new precedent this app doesn't otherwise have; `reviewed_at` alone (an existence + recency signal) is on-pattern and sufficient.

## Global Constraints

- Auth: the new review endpoint uses `project: Project = Depends(get_current_project)` (API-key auth), exactly matching every existing `/experiments` endpoint and `PATCH /traces/{trace_id}/flags/{flag_id}` — not `get_current_user`.
- No new dependency, no new table. Two nullable columns only: `human_verdict BOOLEAN` (`NULL` = not yet reviewed), `reviewed_at TIMESTAMPTZ` (`NULL` = not yet reviewed, set together with `human_verdict` in the same write).
- The automated `passed` and `scores` columns on `ExperimentResult` are never modified by this feature — the human verdict is additive, displayed alongside the automated one, never overwriting it.
- Migrations are plain root-level `.sql` files, idempotent (`ADD COLUMN IF NOT EXISTS`), applied via `.github/workflows/eval.yml`'s hardcoded ordered list — the last entry today is `add_otel_export.sql`.
- This repo's only testing convention is live-server integration tests over real HTTP (`tests/conftest.py`'s fixtures, unchanged).
- Nothing pushed to `origin/main` until the user says so — same standing instruction as every other phase this session; commit locally only.

---

### Task 1: Migration + backend model, schema, and endpoint

**Files:**
- Create: `add_experiment_result_review.sql`
- Modify: `.github/workflows/eval.yml` (migration list)
- Modify: `main.py` — `ExperimentResult` model columns, `ExperimentResultResponse` schema fields, new `ExperimentResultReview` request schema, new `PATCH /experiments/{experiment_id}/results/{result_id}/review` endpoint

**Interfaces:**
- Produces: `experiment_results.human_verdict` (BOOLEAN), `experiment_results.reviewed_at` (TIMESTAMPTZ) — Task 2's tests and Task 3's UI both consume these exact names via `GET /experiments/{id}`'s existing response shape.

- [ ] **Step 1: Write the migration**

```sql
-- add_experiment_result_review.sql
-- Human-in-the-loop calibration for the Evaluation system: lets a
-- reviewer mark agree/disagree on a saved ExperimentResult's automated
-- verdict. Additive only -- never overwrites `passed`/`scores`. No
-- reviewer-identity column: this app's other dashboard review actions
-- (e.g. PATCH /traces/{id}/flags/{id}) don't attribute to a specific
-- logged-in user either, since the dashboard's data-plane calls all
-- authenticate via the project's API key, not a human login session.

ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS human_verdict BOOLEAN;
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
```

Apply it to the local dev Postgres the same way every other migration this session was applied:
```
docker exec -i llm-observability-db psql -U llm_observability -d llm_observability -f - < add_experiment_result_review.sql
```
Confirm both `ALTER TABLE` statements succeed, then re-run the same command a second time to confirm idempotency (no errors, since `IF NOT EXISTS` is used).

- [ ] **Step 2: Add it to the CI migration list**

In `.github/workflows/eval.yml`, the line ending `...add_data_retention.sql add_otel_export.sql; do` becomes:
```
...add_data_retention.sql add_otel_export.sql add_experiment_result_review.sql; do
```

- [ ] **Step 3: Add the two columns to the `ExperimentResult` model**

In `main.py`, the `ExperimentResult` class (currently ending with `trace_id = Column(UUID(as_uuid=True), ForeignKey("traces.id", ondelete="SET NULL"))` per this session's earlier research — read the actual current last column before editing, since later phases may have touched this file), add:

```python
    # Human calibration signal (see add_experiment_result_review.sql) --
    # NULL means "not yet reviewed." Additive only: never overwrites
    # `passed`/`scores`, which stay the automated judgment. Set together,
    # always both-or-neither -- never partially set.
    human_verdict = Column(Boolean)
    reviewed_at = Column(DateTime(timezone=True))
```

- [ ] **Step 4: Add the two fields to `ExperimentResultResponse`**

In `main.py`, `ExperimentResultResponse` (currently: `id`, `experiment_id`, `created_at`, plus everything inherited from `ExperimentResultIn`), add before `model_config`:

```python
    human_verdict: Optional[bool] = None
    reviewed_at: Optional[datetime] = None
```

- [ ] **Step 5: Add the request schema**

Add near `ExperimentResultIn`/`ExperimentResultResponse`:

```python
class ExperimentResultReview(BaseModel):
    agree: bool
```

- [ ] **Step 6: Add the endpoint**

Add near the other `/experiments/{experiment_id}/...` endpoints (e.g. right after `get_experiment` or near `analyze_experiment`):

```python
@app.patch("/experiments/{experiment_id}/results/{result_id}/review", response_model=ExperimentResultResponse)
def review_experiment_result(
    experiment_id: uuid.UUID,
    result_id: uuid.UUID,
    body: ExperimentResultReview,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
):
    experiment = db.get(Experiment, experiment_id)
    if experiment is None or experiment.project_id != project.id:
        raise HTTPException(status_code=404, detail="Experiment not found")
    result = db.get(ExperimentResult, result_id)
    if result is None or result.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Experiment result not found")
    result.human_verdict = body.agree
    result.reviewed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(result)
    return result
```

(This mirrors `resolve_trace_flag`'s exact two-step existence-and-ownership check: look up the parent by id, 404 if missing or wrong project; look up the child by id, 404 if missing or wrong parent.)

- [ ] **Step 7: Verify**

`python -m py_compile main.py && python -c "import main"` — clean, no traceback. Restart the local backend (kill whatever's on port 8010, `python -m uvicorn main:app --port 8010`), confirm `GET /docs` returns 200 and shows the new endpoint.

- [ ] **Step 8: Commit**

```bash
git add add_experiment_result_review.sql .github/workflows/eval.yml main.py
git commit -m "Add human-in-the-loop experiment result review (agree/disagree)"
```

---

### Task 2: Test suite

**Files:**
- Create: `tests/test_experiment_review.py`

**Interfaces:**
- Consumes: `admin_headers`, `project`, `api_headers` fixtures (existing, `tests/conftest.py`, unchanged).

- [ ] **Step 1: Write the tests** (live-server convention, same shape as `tests/test_experiments.py`)

Cover:
- Creating an experiment with results, then `PATCH /experiments/{id}/results/{result_id}/review` with `{"agree": true}` returns 200 with `human_verdict: true` and a non-null `reviewed_at`; `GET /experiments/{id}` reflects the same values afterward.
- `{"agree": false}` on a different result sets `human_verdict: false`.
- A result that's never been reviewed shows `human_verdict: null`, `reviewed_at: null` in `GET /experiments/{id}`.
- Reviewing a result does NOT change its `passed`/`scores` values (assert they're unchanged before/after).
- A `result_id` that belongs to a different experiment returns 404 (mirrors `resolve_trace_flag`'s cross-experiment ownership check).
- A nonexistent `experiment_id` returns 404.

- [ ] **Step 2: Run and fix**

`python -m pytest tests/test_experiment_review.py -v` — iterate until green.

- [ ] **Step 3: Full regression run**

Run the full suite properly tracked in the background (never a manually-tailed redirected log — this repo has been repeatedly bitten by Windows stdout buffering making a genuinely-running process look stalled): `python -u -m pytest tests/ -v`. Confirm all pre-existing tests plus the new ones pass. Takes ~12-13 minutes; wait for actual completion.

- [ ] **Step 4: Commit**

```bash
git add tests/test_experiment_review.py
git commit -m "Add test suite for experiment result review"
```

---

### Task 3: Frontend UI

**Files:**
- Modify: `frontend/src/api.js` — new `reviewExperimentResult` function
- Modify: `frontend/src/pages/ExperimentDetail.jsx` — thumbs-up/down control in `ResultsTab`

**Interfaces:**
- Consumes: the `PATCH /experiments/{experiment_id}/results/{result_id}/review` endpoint from Task 1; `human_verdict`/`reviewed_at` fields already flow through automatically once Task 1's `ExperimentResultResponse` change is live (no other frontend data-fetching change needed).

- [ ] **Step 1: Add the API function**

In `frontend/src/api.js`, near `resolveTraceFlag` (which uses this exact `request(path, {method, body, errorMessage})` wrapper — read it first to match the string-template style used elsewhere in this file):

```js
export const reviewExperimentResult = (experimentId, resultId, agree) =>
  request(`/experiments/${experimentId}/results/${resultId}/review`, {
    method: "PATCH",
    body: { agree },
    errorMessage: "Failed to save review",
  });
```

- [ ] **Step 2: Add the UI control**

In `frontend/src/pages/ExperimentDetail.jsx`'s `ResultsTab` (the function that renders each `ExperimentResult` row — read its current structure first, since it also handles the diff-against-a-comparison-experiment view), add a small thumbs-up/thumbs-down control per result:

- Two buttons (agree / disagree), each calling `reviewExperimentResult(experiment.id, result.id, true|false)` on click, then refreshing local state so the row reflects the new `human_verdict` without a full page reload (mirror the loading/error-handling shape `Review.jsx`'s `resolveTraceFlag` call site uses — track a per-row "saving" state, catch and surface errors the same way).
- Visually indicate the current state: highlight whichever button matches `result.human_verdict` (`true` → agree highlighted, `false` → disagree highlighted, `null`/`undefined` → neither highlighted, both available).
- Keep this compact — a couple of small icon buttons next to the existing scores display, not a new section or modal.

- [ ] **Step 3: Manual smoke test**

Point `frontend/.env`'s `VITE_API_BASE` at `http://localhost:8010` (the local backend from Task 1), restart the Vite dev server, open an experiment with results, click agree on one result and disagree on another, reload the page, and confirm both states persisted. Check the browser console for errors. Restore `VITE_API_BASE` to the Render URL afterward and restart the Vite dev server again.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.js frontend/src/pages/ExperimentDetail.jsx
git commit -m "Add agree/disagree review control to Experiment results"
```

---

### Critical Files for Implementation

- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\main.py` — `ExperimentResult` model, `ExperimentResultResponse`/`ExperimentResultReview` schemas, the new review endpoint
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\add_experiment_result_review.sql` — new migration (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\.github\workflows\eval.yml` — CI migration list ordering
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\tests\test_experiment_review.py` — new test suite (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\api.js` — new `reviewExperimentResult` function
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\pages\ExperimentDetail.jsx` — `ResultsTab`'s new review control
