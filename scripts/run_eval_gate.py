"""
CI eval gate — our own equivalent of Braintrust's eval-action (see
https://github.com/braintrustdata/eval-action), adapted to run against this
project's own FastAPI backend instead of the Braintrust SDK/API.

Runs a small, checked-in set of eval cases (eval/ci_cases.json) against the
running backend's real /evaluation/run_one endpoint, compares the results to
a committed baseline (eval/eval-baseline.json), and writes a markdown summary
(eval_summary.md) for the workflow to post as a PR comment.

Usage:
    python scripts/run_eval_gate.py                  # compare against baseline, write summary
    python scripts/run_eval_gate.py --update-baseline # also overwrite the baseline file

Environment:
    BACKEND_URL       base URL of the running backend (default http://localhost:8010)
    EVAL_PROVIDERS    comma-separated provider list to run (default "groq")
    FAIL_ON_REGRESSION  "true" to exit non-zero if any previously-passing case now fails
"""

import json
import os
import sys
from pathlib import Path

import requests

# stdout's default encoding is locale-dependent (e.g. cp1252 on a Windows
# console) and can't encode the ▲/▼/▬ markers this script prints — reconfigure
# it to UTF-8 so `python scripts/run_eval_gate.py` doesn't crash on Windows
# the same way it wouldn't on a (UTF-8-default) GitHub Actions Linux runner.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = ROOT / "eval" / "ci_cases.json"
BASELINE_PATH = ROOT / "eval" / "eval-baseline.json"
SUMMARY_PATH = ROOT / "eval_summary.md"

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")
PROVIDERS = [p.strip() for p in os.environ.get("EVAL_PROVIDERS", "groq").split(",") if p.strip()]
FAIL_ON_REGRESSION = os.environ.get("FAIL_ON_REGRESSION", "false").lower() == "true"


def run_case(case: dict, provider: str) -> dict:
    resp = requests.post(
        f"{BACKEND_URL}/evaluation/run_one",
        json={"provider": provider, "question": case["question"], "expected": case.get("expected")},
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    return {
        "question": case["question"],
        "provider": provider,
        "passed": result["passed"],
        "faithfulness": result["faithfulness"],
        "relevance": result["relevance"],
        "latency_ms": result["latency_ms"],
        "cost": result["cost"],
        "error": result.get("error"),
    }


def aggregate(results: list[dict]) -> dict:
    if not results:
        return {"pass_rate": None, "avg_faithfulness": None, "avg_latency_ms": None, "avg_cost": None}
    graded = [r for r in results if r["passed"] is not None]
    faith = [r["faithfulness"] for r in results if r["faithfulness"] is not None]
    return {
        "pass_rate": (sum(1 for r in graded if r["passed"]) / len(graded)) if graded else None,
        "avg_faithfulness": (sum(faith) / len(faith)) if faith else None,
        "avg_latency_ms": sum(r["latency_ms"] for r in results) / len(results),
        "avg_cost": sum(r["cost"] for r in results) / len(results),
    }


def fmt_pct(v):
    return "—" if v is None else f"{v * 100:.1f}%"


def fmt_delta_pct(before, after):
    if before is None or after is None:
        return ""
    delta = (after - before) * 100
    arrow = "▲" if delta > 0 else "▼" if delta < 0 else "▬"
    return f" ({arrow}{abs(delta):.1f}pp)"


def fmt_delta_num(before, after, suffix=""):
    if before is None or after is None:
        return ""
    delta = after - before
    arrow = "▲" if delta > 0 else "▼" if delta < 0 else "▬"
    return f" ({arrow}{abs(delta):.4g}{suffix})"


def main():
    update_baseline = "--update-baseline" in sys.argv

    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    results = [run_case(case, provider) for case in cases for provider in PROVIDERS]
    current = aggregate(results)

    baseline_results = json.loads(BASELINE_PATH.read_text(encoding="utf-8")) if BASELINE_PATH.exists() else None
    baseline = aggregate(baseline_results) if baseline_results else None

    # Per-case regressions: cases that passed on the baseline but fail now,
    # matched by (question, provider) — the same pairing ExperimentDetail.jsx
    # uses in the Compare-to view on the frontend.
    regressions = []
    if baseline_results:
        baseline_by_key = {(r["question"], r["provider"]): r for r in baseline_results}
        for r in results:
            prior = baseline_by_key.get((r["question"], r["provider"]))
            if prior and prior["passed"] and r["passed"] is False:
                regressions.append(r)

    def row(label, key, fmt_value, suffix=""):
        current_str = fmt_value(current[key])
        if baseline is None:
            return f"| {label} | — | {current_str} |"
        baseline_str = fmt_value(baseline[key])
        if suffix == "%":
            delta_str = fmt_delta_pct(baseline[key], current[key])
        else:
            delta_str = fmt_delta_num(baseline[key], current[key], suffix)
        return f"| {label} | {baseline_str} | {current_str}{delta_str} |"

    lines = ["## Eval Gate Results", ""]
    lines.append(f"Ran {len(cases)} case(s) x {len(PROVIDERS)} provider(s) = {len(results)} total.")
    lines.append("")
    lines.append("| Metric | Baseline | Current |")
    lines.append("|---|---|---|")
    lines.append(row("Pass Rate", "pass_rate", fmt_pct, suffix="%"))
    lines.append(row("Avg Faithfulness", "avg_faithfulness", fmt_pct, suffix="%"))
    lines.append(row("Avg Latency", "avg_latency_ms", lambda v: f"{v:.0f}ms", suffix="ms"))
    lines.append(row("Avg Cost", "avg_cost", lambda v: f"${v:.6f}"))
    lines.append("")

    if not baseline_results:
        lines.append("_No baseline yet — this run will become the baseline once merged to main._")
    elif regressions:
        lines.append(f"### ⚠ {len(regressions)} case(s) regressed (previously passing, now failing)")
        for r in regressions:
            lines.append(f"- `{r['provider']}` — {r['question']}")
    else:
        lines.append("No regressions vs. baseline.")

    errored = [r for r in results if r.get("error")]
    if errored:
        lines.append("")
        lines.append(f"### 🛑 {len(errored)} case(s) failed to call the provider at all")
        lines.append("These aren't graded regressions — the provider call itself raised an exception:")
        for r in errored:
            lines.append(f"- `{r['provider']}` — {r['question']}: `{r['error']}`")

    summary = "\n".join(lines)
    SUMMARY_PATH.write_text(summary, encoding="utf-8")
    print(summary)

    if update_baseline:
        BASELINE_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"\nBaseline updated: {BASELINE_PATH}")

    if FAIL_ON_REGRESSION and regressions:
        print(f"\nFAIL_ON_REGRESSION is set and {len(regressions)} case(s) regressed — failing the job.")
        sys.exit(1)


if __name__ == "__main__":
    main()
