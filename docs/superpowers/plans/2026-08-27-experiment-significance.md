# Statistical Significance Testing for Experiment Comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

This is the third of four independent sub-projects that make up "Phase 5: advanced evaluation" (build order confirmed with the user: Human review [done] → Custom scorers [done] → Comparison/statistical significance [this plan] → Multi-turn evaluation). Today, `ExperimentDetail.jsx`'s comparison table shows raw before/after deltas (pass-rate percentage points, per-scorer average-score percentage points) between the current experiment and a user-selected `compareExperiment` — but a delta alone can't tell a user whether a change is real or just noise from a small/variable eval set. This plan adds two paired statistical significance tests, computed server-side, and surfaces them as a badge next to the existing delta cells (no new tab/page).

Two design facts drive the whole shape of this plan:

- **`scipy` is a new pip dependency, approved despite this session's general "avoid new deps" bias** — the same reasoning that justified adding the `regex` package for this session's earlier ReDoS fix: this is a correctness-critical case. Hand-rolling exact small-sample McNemar's/Wilcoxon p-value math (binomial tail probabilities, Wilcoxon signed-rank exact/normal-approximation distributions) risks a subtle statistical bug that would silently mislead a user about whether their result is real. Neither `scipy` nor `numpy` exist anywhere in this repo today (confirmed via grep of `main.py` and `requirements.txt`); `numpy` is not added as a separate line since it arrives automatically as `scipy`'s own transitive dependency.
- **There is no existing "compare two things of the same type" endpoint anywhere in this app to follow as precedent.** Every other two-ID endpoint in `main.py` (`PATCH /traces/{trace_id}/flags/{flag_id}`, `PATCH /experiments/{experiment_id}/results/{result_id}/review`, etc.) is parent-then-child: the second ID only makes sense scoped inside the first. `GET /experiments/{experiment_id}/significance?compare_id=<uuid>` is the first endpoint in this codebase where two IDs name two independent sibling resources of the identical type, each needing its own full `db.get(...)` + `is None or .project_id != project.id` 404 check (mirroring `get_experiment`'s existing idiom at `main.py:3770-3775`, just done twice). This plan is greenfield backend work in that specific sense — it does not invent a fictitious "diff two X" pattern that doesn't already exist in the codebase; it reuses the closest real precedent (`get_experiment`'s 404 idiom) applied twice.

## Global Constraints

- **Test choice is fixed, do not substitute:** McNemar's test for paired binary pass/fail outcomes; Wilcoxon signed-rank test for paired continuous per-scorer scores (0-1 floats). Wilcoxon was chosen over a paired t-test specifically because eval datasets here are often small and score distributions won't reliably be normal — do not "simplify" to a t-test.
- **`scipy.stats` has no direct `mcnemar` function** (that lives in `statsmodels`, which is NOT being added — stay `scipy`-only). McNemar's test must be implemented directly from its definition using `scipy.stats.binomtest`/`scipy.stats.chi2` primitives, exactly as specified below. Do not improvise the statistics.
- **Exact McNemar's formula** (per provider): build the 2×2 contingency table of (A-pass/A-fail) × (B-pass/B-fail) over paired rows where BOTH sides have a non-null `passed`. Extract the two discordant cell counts: `b` = A pass, B fail; `c` = A fail, B pass. Concordant pairs (both pass or both fail) don't contribute to the test itself, only to `n`.
  - If `b + c == 0` (A and B agree on every paired case): `p_value = 1.0` — a special case, never call the exact/chi-square math with a zero denominator.
  - Else if `b + c < 25`: exact test — `p_value = scipy.stats.binomtest(min(b, c), n=b+c, p=0.5).pvalue` (two-sided by default).
  - Else (`b + c >= 25`): chi-square approximation with continuity correction — `chi2_stat = (abs(b - c) - 1) ** 2 / (b + c)`, `p_value = scipy.stats.chi2.sf(chi2_stat, df=1)`.
- **Exact Wilcoxon formula** (per provider, per scorer key): `scipy.stats.wilcoxon(x, y)` on the two paired score arrays directly (scipy handles ranking, zero-differences, and picks exact vs. normal-approximation p-values automatically based on sample size). `wilcoxon` raises `ValueError` when every paired difference is exactly zero (`x == y` for all pairs) — catch it and treat it as `p_value = 1.0`, the same "no evidence of any difference is a valid, expected outcome, not an error" reasoning as McNemar's `b + c == 0` case. Do not let this exception propagate and 500 the endpoint.
- **The paired sample size `n`** for the low-power caveat is, for McNemar's, the count of rows where BOTH sides have a non-null `passed` (the full paired-and-gradeable sample, not just the discordant count `b + c`); for Wilcoxon, the count of paired rows where BOTH sides have a non-null value for that specific scorer key.
- **`n < 10` → `low_power: true`**, per test result (per-provider for McNemar's, per-provider-per-scorer for Wilcoxon) — a per-test-result flag, never a global one, since different providers/scorers can have different numbers of gradeable pairs. **Always show the p-value regardless of `n`** — never hide/omit a significance result below this threshold, only flag it.
- **`significant: bool` is `p_value < 0.05`.** This exact alpha threshold is a plan-level implementation decision (not something the user was asked about) needed only to render a boolean badge color; it is the conventional default and is not up for silent renegotiation during implementation — if it needs to change, that's a product decision to raise explicitly, not something to improvise inline.
- **Pairing logic must mirror `ExperimentDetail.jsx:396-404`'s `matchedRows` exactly, server-side.** One-directional match: iterate the PRIMARY experiment's results, look each up in the COMPARE experiment's results by a `{question}||{provider}` composite key. If the compare experiment has duplicate `(question, provider)` rows, keep the last one encountered when building the lookup dict — mirror this pre-existing quirk of the app's own established pairing logic exactly, do not "fix" it or diverge from it. Rows with no match are excluded from every paired test.
- **Scorer keys are discovered from the data, never hardcoded** — `ExperimentResult.scores` is a free-form `dict[str, float]` (JSONB), so the set of scorer keys to run Wilcoxon over must be the union of keys actually present across both experiments' results, mirroring `frontend/src/utils.js`'s `scoreKeys()` helper's union-of-keys approach (backend re-implements this in Python; it does not import the JS helper).
- **No new DB columns, no new migration file.** This feature is pure computation over existing `ExperimentResult`/`Experiment` data already in Postgres — confirmed by reviewing both models (`main.py:491-511`, `main.py:518-542`); nothing here needs persisting.
- **No new tab/page.** The existing `OverviewTab` comparison table (`frontend/src/pages/ExperimentDetail.jsx:70-159`) is enhanced in place — a significance badge attaches next to the existing `DeltaText` cells for pass rate and each score key. Do not build a separate "Compare" view.
- **No dependencies beyond `scipy`.** Do not add `numpy` or `statsmodels` as separate `requirements.txt` lines — `numpy` arrives automatically as `scipy`'s own dependency.
- **The 404 idiom to reuse, twice:** `db.get(Model, id)` then `if x is None or x.project_id != project.id: raise HTTPException(404, ...)` — exactly as `get_experiment` (`main.py:3770-3775`) does today, applied once for `experiment_id` and once for `compare_id`.
- **CSS variables `--brand-success`, `--brand-warning`, `--brand-danger` are confirmed to exist** in `frontend/src/index.css` (lines 22-24: `#5cc180`, `#e0a44d`, `#f0847b`) — safe to reference in the new badge component.
- This repo's only testing convention is live-server integration tests over real HTTP (`tests/conftest.py`'s fixtures, unchanged) — no in-process `TestClient`, no mocking of `scipy`.
- Nothing pushed to `origin/main` until the user says so — commit locally only.

---

### Task 1: `scipy` dependency + backend significance endpoint

**Files:**
- Modify: `requirements.txt` (new dependency line)
- Modify: `main.py` — imports, new Pydantic schemas (insert after `ExperimentResponse`, `main.py:1171-1182`), new helper functions (insert after `_experiment_pass_rate`, `main.py:3717-3722`), new endpoint (insert after `get_experiment`, `main.py:3770-3776`)

**Interfaces:**
- Produces: `GET /experiments/{experiment_id}/significance?compare_id=<uuid>` returning `ExperimentSignificanceResponse` (`mcnemar: list[McNemarResult]`, `wilcoxon: list[WilcoxonResult]`). Task 2's tests and Task 3's frontend both consume this exact response shape and these exact field names (`provider`, `scorer_key`, `n`, `b`, `c`, `p_value`, `significant`, `low_power`).

- [ ] **Step 1: Add the dependency**

In `requirements.txt`, add `scipy` as a new line after `regex` (the last line today). `pip install -r requirements.txt` locally to confirm it resolves (pulls in `numpy` transitively — do not add `numpy` as its own line). No version pin needed.

- [ ] **Step 2: Add the two new imports**

Read the actual current top-of-file import block in `main.py` first (it may have shifted since this plan was written — Custom Scorer Types and other sub-projects touched this file recently). Add `import regex`-style: `from collections import defaultdict` to the stdlib imports if `defaultdict` isn't already imported (check first — do not add a duplicate import), and `from scipy import stats` to the third-party import block, alongside the existing `from pydantic import ...` / `from sqlalchemy import ...` lines.

- [ ] **Step 3: Add the Pydantic response schemas**

In `main.py`, insert immediately after `ExperimentResponse`'s closing `model_config = ConfigDict(from_attributes=True)` line (read the actual current location first — search for `class ExperimentResponse`):

```python
# Statistical significance of a paired comparison between two experiments —
# see _paired_rows/_mcnemar_test/_wilcoxon_test below. Computed fresh on
# every request, never persisted.
SIGNIFICANCE_ALPHA = 0.05
LOW_POWER_THRESHOLD = 10  # n below this -> low_power=True, shown as a caveat, never hidden


# One provider's McNemar's test result over its paired pass/fail outcomes.
# b/c are the two discordant contingency-table cells: b = A passed, B
# failed; c = A failed, B passed. n is the full paired-and-gradeable
# sample (both sides have a non-null `passed`), not just b + c -- matching
# what a reader expects "how many cases fed this test."
class McNemarResult(BaseModel):
    provider: str
    n: int
    b: int
    c: int
    p_value: float
    significant: bool
    low_power: bool


# One (provider, scorer_key) Wilcoxon signed-rank test result over its
# paired continuous scores. n is the count of paired rows where BOTH sides
# have a non-null value for this specific scorer key.
class WilcoxonResult(BaseModel):
    provider: str
    scorer_key: str
    n: int
    p_value: float
    significant: bool
    low_power: bool


class ExperimentSignificanceResponse(BaseModel):
    experiment_id: uuid.UUID
    compare_id: uuid.UUID
    mcnemar: list[McNemarResult]
    wilcoxon: list[WilcoxonResult]
```

- [ ] **Step 4: Add the pairing + statistics helper functions**

In `main.py`, insert immediately after `_experiment_pass_rate` (search for it — right before `@app.get("/experiments", ...)`):

```python
# Every distinct scorer key actually present across the given lists of
# ExperimentResult rows -- mirrors frontend/src/utils.js's scoreKeys()
# exactly (union of dict keys over all rows, not a hardcoded list), since
# ExperimentResult.scores is a free-form JSONB map and the set of keys is
# only knowable from the data itself.
def _scorer_keys(*result_lists: list["ExperimentResult"]) -> list[str]:
    keys = set()
    for results in result_lists:
        for r in results:
            keys.update((r.scores or {}).keys())
    return sorted(keys)


# Matches each row in the PRIMARY experiment's results to its counterpart in
# the COMPARE experiment's results by (question, provider) -- mirrors
# frontend/src/pages/ExperimentDetail.jsx:396-404's matchedRows EXACTLY,
# including its one-directional-lookup quirk: if the compare experiment has
# duplicate (question, provider) rows, the lookup dict silently keeps the
# LAST one encountered. This is a pre-existing quirk of the frontend's own
# established pairing logic -- mirrored here on purpose, not "fixed", so
# this endpoint's statistical tests run over the exact same pairs the
# Results tab already visually diffs. Rows with no match are excluded.
def _paired_rows(
    primary_results: list["ExperimentResult"], compare_results: list["ExperimentResult"]
) -> list[tuple["ExperimentResult", "ExperimentResult"]]:
    compare_by_key = {}
    for r in compare_results:
        compare_by_key[f"{r.question}||{r.provider}"] = r
    pairs = []
    for a in primary_results:
        comp = compare_by_key.get(f"{a.question}||{a.provider}")
        if comp is not None:
            pairs.append((a, comp))
    return pairs


# McNemar's test over one provider's paired pass/fail outcomes. `pairs` is
# already filtered to rows for a single provider (a.provider == comp.provider
# for every pair, by construction of _paired_rows's join key). See Global
# Constraints for the exact formula -- do not change this math without
# re-deriving it from McNemar's test's definition.
def _mcnemar_test(pairs: list[tuple["ExperimentResult", "ExperimentResult"]]) -> dict:
    gradeable = [(a, comp) for a, comp in pairs if a.passed is not None and comp.passed is not None]
    n = len(gradeable)
    b = sum(1 for a, comp in gradeable if a.passed and not comp.passed)  # A passed, B failed
    c = sum(1 for a, comp in gradeable if not a.passed and comp.passed)  # A failed, B passed
    discordant = b + c
    if discordant == 0:
        # A and B agree on every paired case -- no evidence of any
        # difference is a valid, expected outcome, not an error. Never call
        # the exact/chi-square math below with a zero denominator.
        p_value = 1.0
    elif discordant < 25:
        p_value = stats.binomtest(min(b, c), n=discordant, p=0.5).pvalue
    else:
        chi2_stat = (abs(b - c) - 1) ** 2 / discordant
        p_value = stats.chi2.sf(chi2_stat, df=1)
    return {"n": n, "b": b, "c": c, "p_value": float(p_value)}


# Wilcoxon signed-rank test over one (provider, scorer_key)'s paired
# continuous scores. `pairs` is already filtered to a single provider.
# Returns None (meaning: omit this provider/scorer combo from the response
# entirely) only when there are zero gradeable pairs -- there is nothing
# meaningful to report, not even a caveatable low-n result.
def _wilcoxon_test(pairs: list[tuple["ExperimentResult", "ExperimentResult"]], scorer_key: str) -> Optional[dict]:
    x, y = [], []
    for a, comp in pairs:
        av = (a.scores or {}).get(scorer_key)
        cv = (comp.scores or {}).get(scorer_key)
        if av is not None and cv is not None:
            x.append(av)
            y.append(cv)
    n = len(x)
    if n == 0:
        return None
    try:
        _stat, p_value = stats.wilcoxon(x, y)
    except ValueError:
        # scipy raises ValueError when every paired difference is exactly
        # zero (x == y for all n pairs) -- "no evidence of any difference"
        # is a valid, expected outcome here, not an error, exactly like
        # McNemar's discordant == 0 case above.
        p_value = 1.0
    return {"n": n, "p_value": float(p_value)}
```

- [ ] **Step 5: Add the endpoint**

In `main.py`, insert immediately after `get_experiment` (search for `def get_experiment`, right before the `PATCH /experiments/{experiment_id}/results/{result_id}/review` endpoint):

```python
# GET /experiments/{experiment_id}/significance -- paired statistical
# significance between two experiments' results, layered alongside (not
# replacing) the unpaired aggregateByProvider deltas the frontend already
# shows. This is the first endpoint in this app naming two independent
# sibling resources of the identical type (every other two-ID endpoint is
# parent-then-child), so both IDs get their own full 404 check, mirroring
# get_experiment's own idiom above, applied twice.
@app.get("/experiments/{experiment_id}/significance", response_model=ExperimentSignificanceResponse)
def get_experiment_significance(
    experiment_id: uuid.UUID,
    compare_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
):
    db_experiment = db.get(Experiment, experiment_id)
    if db_experiment is None or db_experiment.project_id != project.id:
        raise HTTPException(status_code=404, detail="Experiment not found")

    db_compare = db.get(Experiment, compare_id)
    if db_compare is None or db_compare.project_id != project.id:
        raise HTTPException(status_code=404, detail="Comparison experiment not found")

    pairs = _paired_rows(db_experiment.results, db_compare.results)
    pairs_by_provider = defaultdict(list)
    for a, comp in pairs:
        pairs_by_provider[a.provider].append((a, comp))

    mcnemar_results = []
    for provider, provider_pairs in sorted(pairs_by_provider.items()):
        result = _mcnemar_test(provider_pairs)
        mcnemar_results.append(
            McNemarResult(
                provider=provider,
                n=result["n"],
                b=result["b"],
                c=result["c"],
                p_value=result["p_value"],
                significant=result["p_value"] < SIGNIFICANCE_ALPHA,
                low_power=result["n"] < LOW_POWER_THRESHOLD,
            )
        )

    scorer_keys = _scorer_keys(db_experiment.results, db_compare.results)
    wilcoxon_results = []
    for provider, provider_pairs in sorted(pairs_by_provider.items()):
        for key in scorer_keys:
            result = _wilcoxon_test(provider_pairs, key)
            if result is None:
                continue
            wilcoxon_results.append(
                WilcoxonResult(
                    provider=provider,
                    scorer_key=key,
                    n=result["n"],
                    p_value=result["p_value"],
                    significant=result["p_value"] < SIGNIFICANCE_ALPHA,
                    low_power=result["n"] < LOW_POWER_THRESHOLD,
                )
            )

    return ExperimentSignificanceResponse(
        experiment_id=experiment_id,
        compare_id=compare_id,
        mcnemar=mcnemar_results,
        wilcoxon=wilcoxon_results,
    )
```

Note: providers that appear in `db_experiment.results` but have zero matched pairs in `db_compare.results` never enter `pairs_by_provider` at all, so they simply don't appear in `mcnemar`/`wilcoxon` — the frontend (Task 3) must treat "no result for this provider" as "nothing to show," not as an error.

- [ ] **Step 6: Verify**

`python -m py_compile main.py && python -c "import main"` — clean, no traceback (this also confirms `scipy` actually installed correctly and `from scipy import stats` resolves). Restart the local backend. Manually exercise via `curl`/`/docs`:
- Create two experiments via `POST /experiments` with a few hand-picked, fully-agreeing paired results (same `question`/`provider`, same `passed`, same `scores`) → `GET /experiments/{id}/significance?compare_id=<other>` should return `p_value: 1.0`, `significant: false` for every provider/scorer.
- Create two experiments with an obvious, large systematic pass/fail flip on every paired case → `p_value` close to 0, `significant: true`.
- `GET .../significance` with a `compare_id` that doesn't exist (or belongs to another project) → 404 with `"Comparison experiment not found"`.
- `GET .../significance` with a nonexistent `experiment_id` → 404 with `"Experiment not found"` (confirms the primary-ID check runs, and runs first).
- `GET .../significance` with `compare_id` omitted entirely → 422 (FastAPI's built-in required-query-param validation, since `compare_id: uuid.UUID` has no default).

- [ ] **Step 7: Commit**

```bash
git add requirements.txt main.py
git commit -m "Add McNemar's/Wilcoxon significance endpoint for experiment comparison"
```

---

### Task 2: Test suite

**Files:**
- Create: `tests/test_experiment_significance.py`

**Interfaces:**
- Consumes: `project`, `api_headers` fixtures (existing, `tests/conftest.py`, unchanged); `POST /experiments` (accepts inline `results`, no separate eval run needed — see `tests/test_experiments.py` for the same pattern); `GET /experiments/{id}/significance` from Task 1.

- [ ] **Step 1: Write the tests**

```python
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
p-value). Run with the backend + Postgres already up and migrated:
    pytest tests/test_experiment_significance.py -v
"""

import os

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
```

- [ ] **Step 2: Run and fix**

`python -m pytest tests/test_experiment_significance.py -v` — iterate until green. If `test_large_systematic_flip_is_significant`'s `p_value < 0.001` bound is ever too tight for `binomtest`'s exact output at n=20 (it shouldn't be — `binomtest(0, n=20, p=0.5)` is on the order of `2 * 0.5**20 ≈ 1.9e-6`), loosen only that numeric bound, never the `significant is True` assertion itself.

- [ ] **Step 3: Full regression run**

Run the full suite properly tracked in the background (never a manually-tailed redirected log — this repo has been repeatedly bitten by Windows stdout buffering making a genuinely-running process look stalled): `python -u -m pytest tests/ -v`. Confirm all pre-existing tests plus the new ones pass. Wait for actual completion.

- [ ] **Step 4: Commit**

```bash
git add tests/test_experiment_significance.py
git commit -m "Add test suite for experiment comparison significance endpoint"
```

---

### Task 3: Frontend UI — significance badge on the existing comparison table

**Files:**
- Modify: `frontend/src/api.js` (new `getExperimentSignificance` function, after `analyzeExperiment`)
- Modify: `frontend/src/pages/ExperimentDetail.jsx` (fetch trigger, new `SignificanceBadge` component, wiring into `OverviewTab`'s table cells)

**Interfaces:**
- Consumes: `GET /experiments/{id}/significance` from Task 1, via the new `getExperimentSignificance(id, compareId)` API function.

- [ ] **Step 1: Add the API function**

In `frontend/src/api.js`, insert immediately after `analyzeExperiment` (search for it):

```javascript
// Paired statistical significance (McNemar's for pass/fail, Wilcoxon
// signed-rank for per-scorer scores) between this experiment and
// compareId, computed fresh server-side on every call -- see
// GET /experiments/{id}/significance in main.py. Query param, not a second
// path segment, since there's no existing "two sibling IDs" path precedent
// in this app to follow (same idiom as getIncidents(params)/
// getAgentCosts(windowMinutes)).
export const getExperimentSignificance = (id, compareId) =>
  request(`/experiments/${id}/significance`, {
    params: { compare_id: compareId },
    errorMessage: "Failed to compute significance",
  });
```

- [ ] **Step 2: Fetch significance whenever `compareId` changes**

In `frontend/src/pages/ExperimentDetail.jsx` (read the actual current file first — search for each anchor rather than trusting stale line numbers):

1. Update the import line to add `getExperimentSignificance`:
```javascript
import { getExperiment, getExperiments, analyzeExperiment, reviewExperimentResult, getExperimentSignificance } from "../api";
```

2. Add a new `significance` state next to the existing `compareExperiment` state:
```javascript
const [significance, setSignificance] = useState(null);
```

3. Reset it in the `id`-change effect, alongside the existing `setCompareId("")`/`setCompareExperiment(null)` resets:
```javascript
setSignificance(null);
```

4. Add a new effect immediately after the existing `compareId`-driven effect (the one that calls `getExperiment(compareId)`), fetching significance on the same trigger:
```javascript
useEffect(() => {
  if (!compareId) {
    setSignificance(null);
    return;
  }
  getExperimentSignificance(id, compareId)
    .then(setSignificance)
    .catch((err) => setError(err.message));
}, [id, compareId]);
```
This is a separate, independent fetch from `compareExperiment`'s own `getExperiment(compareId)` call right above it — both fire off `compareId` changing, but neither waits on the other (the significance endpoint doesn't need the frontend to have already loaded `compareExperiment`'s full result list; it's computed entirely server-side from the two experiment IDs).

- [ ] **Step 3: Add the `SignificanceBadge` component**

In `frontend/src/pages/ExperimentDetail.jsx`, add immediately after the `DeltaText` component (search for it, before `DiffedAnswer`):

```jsx
// Renders next to an existing DeltaText cell in the Overview comparison
// table -- a compact p-value + significant/not-significant label, plus a
// low-power caveat when the paired sample size is small. Always shown when
// a result exists (never hidden below the n < 10 threshold, per the
// approved design) -- the caveat communicates "treat this cautiously"
// without suppressing the number itself.
function SignificanceBadge({ result }) {
  if (!result) return null;
  const { p_value, significant, low_power, n } = result;
  const pLabel = p_value < 0.001 ? "p<0.001" : `p=${p_value.toFixed(3)}`;
  return (
    <span className="inline-flex items-center gap-1 ml-1.5 align-middle">
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
        style={{
          color: significant ? "var(--brand-success)" : "var(--text-muted)",
          backgroundColor: significant
            ? "color-mix(in srgb, var(--brand-success) 15%, transparent)"
            : "color-mix(in srgb, var(--text-muted) 15%, transparent)",
        }}
        title={
          significant
            ? `Statistically significant difference (${pLabel}, n=${n})`
            : `No statistically significant difference detected (${pLabel}, n=${n})`
        }
      >
        {significant ? "significant" : "n.s."} {pLabel}
      </span>
      {low_power && (
        <span
          className="text-[10px] font-medium"
          style={{ color: "var(--brand-warning)" }}
          title={`Only ${n} paired cases fed this test -- treat this result cautiously`}
        >
          ⚠ n={n}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Wire the badge into `OverviewTab`'s comparison table**

In `frontend/src/pages/ExperimentDetail.jsx`, update `OverviewTab`'s signature to accept `significance`:
```javascript
function OverviewTab({ experiment, analysis, analyzing, onAnalyze, aggregates, compareAggregates, allScoreKeys, significance }) {
```

Then update the pass-rate cell (find the existing `compareRow ? (<DeltaText before={compareRow.passRate} after={row.passRate} formatFn={pct} isPercent />) : (pct(row.passRate))` block):
```jsx
<td className="py-2 text-[var(--text-secondary)]">
  {compareRow ? (
    <>
      <DeltaText before={compareRow.passRate} after={row.passRate} formatFn={pct} isPercent />
      <SignificanceBadge result={significance?.mcnemar.find((m) => m.provider === row.provider)} />
    </>
  ) : (
    pct(row.passRate)
  )}
</td>
```

And the per-score-key cell:
```jsx
{allScoreKeys.map((k) => (
  <td key={k} className="py-2 text-[var(--text-secondary)]">
    {compareRow ? (
      <>
        <DeltaText before={compareRow.avgScores[k]} after={row.avgScores[k]} formatFn={pct} isPercent />
        <SignificanceBadge
          result={significance?.wilcoxon.find((w) => w.provider === row.provider && w.scorer_key === k)}
        />
      </>
    ) : (
      pct(row.avgScores[k])
    )}
  </td>
))}
```

`significance?.mcnemar`/`significance?.wilcoxon` safely evaluate to `undefined` (and `.find` is skipped via `?.`) whenever `significance` is `null` (no `compareId` selected yet, or the fetch hasn't resolved) — `SignificanceBadge` already no-ops (`return null`) on an `undefined`/missing `result`, so no extra loading-state guard is needed here. Latency/cost cells are untouched — significance testing only applies to pass rate (McNemar's) and scores (Wilcoxon), not latency or cost.

- [ ] **Step 5: Pass `significance` down from the parent**

In `frontend/src/pages/ExperimentDetail.jsx`, update the `<OverviewTab ... />` call site to add the new prop:
```jsx
{tab === "Overview" && (
  <OverviewTab
    experiment={experiment}
    analysis={analysis}
    analyzing={analyzing}
    onAnalyze={handleAnalyze}
    aggregates={aggregates}
    compareAggregates={compareAggregates}
    allScoreKeys={scoreKeys(experiment.results)}
    significance={significance}
  />
)}
```

- [ ] **Step 6: Manual smoke test**

Point `frontend/.env`'s `VITE_API_BASE` at `http://localhost:8010` (the local backend from Task 1), restart the Vite dev server, open an experiment's detail page, Overview tab:
- With no `compareId` selected: table renders exactly as before (no badges, no console errors from `significance` being `null`).
- Select a `compareId` in the "Compare to" dropdown: badges appear next to the Pass Rate cell and each score-key cell, matching the sign/direction of the existing delta text.
- Compare two experiments known (from Task 2's hand-picked patterns, or two real experiments you construct manually) to agree on every case: badge should read "n.s." with `p=1.000`.
- Compare two experiments with a small number of paired cases (fewer than 10): confirm the `⚠ n=<count>` caveat renders.
- Switch `compareId` back to "None": badges disappear, `significance` resets to `null`, no stale badges linger from the previous selection.
- Check the browser console for errors throughout. Restore `VITE_API_BASE` to the Render URL afterward and restart the Vite dev server again.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.js frontend/src/pages/ExperimentDetail.jsx
git commit -m "Add significance badges to the experiment comparison table"
```

---

### Critical Files for Implementation

- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\main.py` — new `McNemarResult`/`WilcoxonResult`/`ExperimentSignificanceResponse` Pydantic schemas, `_scorer_keys`/`_paired_rows`/`_mcnemar_test`/`_wilcoxon_test` helper functions, `GET /experiments/{experiment_id}/significance` endpoint
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\requirements.txt` — new `scipy` line
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\tests\test_experiment_significance.py` — new test suite (to be created)
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\pages\ExperimentDetail.jsx` — `SignificanceBadge` component, `compareId`-driven significance fetch, `OverviewTab` wiring
- `c:\Users\VenkatManojKumar\Desktop\LLM_Observability\frontend\src\api.js` — new `getExperimentSignificance` function
