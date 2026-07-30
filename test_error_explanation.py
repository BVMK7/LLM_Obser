"""
Test script: deliberately trigger a real LLM API failure, log it as a span
error, and verify the backend automatically fills in error_explanation.

This exercises the full pipeline built in main.py:
    POST /spans (with `error` set) -> _explain_error() -> Groq -> saved to DB

Run with: python test_error_explanation.py
Requires: the FastAPI app running at http://localhost:8010, and Postgres up
(same as the rest of the project). Uses the `requests` package — if you
don't have it, `pip install requests`.
"""

import os

import requests
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv()

API_URL = "http://localhost:8010"
DATABASE_URL = os.environ["DATABASE_URL"]


# 1. Deliberately trigger a REAL error from the Groq API, using an invalid
# API key. We call Groq directly here (not through providers.py) so we get
# back a genuine error message from the real API instead of making one up.
def trigger_real_llm_error():
    from groq import Groq

    print("Step 1: calling Groq with a deliberately invalid API key...")
    bad_client = Groq(api_key="this-is-not-a-real-api-key")

    try:
        bad_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": "This call should fail."}],
        )
        # If we somehow get here, the "bad" key didn't fail — that's unexpected,
        # so we stop rather than silently continuing with no error to test.
        raise RuntimeError("Expected the Groq call to fail, but it succeeded!")
    except RuntimeError:
        raise
    except Exception as e:
        error_message = str(e)
        print(f"Step 1 result: got the expected error:\n  {error_message}\n")
        return error_message


# 2. Spans belong to a trace, so we need a real trace_id to attach this
# failing span to. Create a small throwaway trace via the API.
def create_test_trace():
    print("Step 2: creating a throwaway trace to attach the failing span to...")
    response = requests.post(
        f"{API_URL}/traces",
        json={"name": "test: deliberate error", "input": "trigger a failure on purpose"},
    )
    response.raise_for_status()
    trace = response.json()
    print(f"Step 2 result: created trace {trace['id']}\n")
    return trace["id"]


# 3. POST the span with the real error message in the `error` field. This is
# the same request the real app would send if a step actually failed.
def create_failing_span(trace_id, error_message):
    print("Step 3: POSTing the span with the error field populated...")
    response = requests.post(
        f"{API_URL}/spans",
        json={
            "trace_id": trace_id,
            "step_name": "call_groq_with_bad_key",
            "input": "This call should fail.",
            "error": error_message,
        },
    )
    response.raise_for_status()
    span = response.json()
    print(f"Step 3 result: span created with id {span['id']}")
    print(f"  error:             {span['error']}")
    print(f"  error_explanation: {span['error_explanation']}\n")
    return span["id"]


# 4. Query the database directly (not through the API) to see exactly what's
# stored. This is the source of truth, independent of what the API response
# claimed.
def print_span_from_db(span_id):
    print("Step 4: querying the database directly for this span...")
    engine = create_engine(DATABASE_URL)

    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT id, step_name, error, error_explanation FROM spans WHERE id = :id"),
            {"id": span_id},
        ).fetchone()

    if row is None:
        print("  Nothing found in the database for this span id - that's a real problem.\n")
        return None

    print(f"  id:                {row.id}")
    print(f"  step_name:         {row.step_name}")
    print(f"  error:             {row.error}")
    print(f"  error_explanation: {row.error_explanation}\n")
    return row


# 5. If error_explanation came back empty, walk through the exact same logic
# main.py's _explain_error() runs — but with a print statement after every
# step — so we can see exactly where it's breaking: is Groq even being
# called, is that call throwing an error, or is something else going wrong?
def debug_explain_error(step_name, input_text, error_message):
    print("=" * 60)
    print("error_explanation was empty - debugging _explain_error() step by step")
    print("=" * 60)

    print("\nDebug A: is GROQ_API_KEY set in this environment at all?")
    groq_key_present = bool(os.environ.get("GROQ_API_KEY"))
    print(f"  GROQ_API_KEY present: {groq_key_present}")
    if not groq_key_present:
        print("  --> Without this, every Groq call (including the explanation) will fail.")
        print("      Add GROQ_API_KEY to your .env file and restart the FastAPI server.\n")
        return

    print("\nDebug B: building the same prompt _explain_error() builds...")
    prompt = (
        "You are helping a beginner developer understand an error in their AI pipeline. "
        f"Here is the step that failed: {step_name}. "
        f"Here is the input: {input_text}. "
        f"Here is the raw error: {error_message}. "
        "Explain in 2-3 simple sentences what likely went wrong and suggest one possible fix. "
        "Avoid jargon."
    )
    print(f"  Prompt built successfully ({len(prompt)} characters).")

    print("\nDebug C: calling Groq (via providers.py's call_groq) to generate the explanation...")
    from providers import PROVIDERS

    call_groq = PROVIDERS["groq"]
    try:
        explanation, input_tokens, output_tokens = call_groq(prompt)
    except Exception as e:
        print(f"  --> The Groq call FAILED: {e}")
        print("      This is almost certainly why error_explanation is empty: main.py's")
        print("      _explain_error() catches this same exception and saves a fallback")
        print('      string like "(Couldn\'t generate an explanation: ...)" instead.')
        print("      Check your real GROQ_API_KEY is valid and you haven't hit a rate limit.\n")
        return

    print("  Groq call succeeded!")
    print(f"  explanation:   {explanation}")
    print(f"  input_tokens:  {input_tokens}")
    print(f"  output_tokens: {output_tokens}")
    print("\nDebug D: the explanation was generated successfully just now, so if the")
    print("  database still shows an empty error_explanation, the problem is likely")
    print("  in main.py's create_span() endpoint itself - for example:")
    print("    - it's not running the latest code (restart uvicorn to pick up changes)")
    print("    - the `if db_span.error:` check isn't matching (check for typos/whitespace)")
    print("    - the second db.commit() after setting error_explanation isn't happening\n")


def main():
    error_message = trigger_real_llm_error()
    trace_id = create_test_trace()
    span_id = create_failing_span(trace_id, error_message)
    row = print_span_from_db(span_id)

    explanation = row.error_explanation if row is not None else None
    # main.py's _explain_error() saves this exact fallback string when its own
    # Groq call fails — so a "non-empty" explanation can still mean the
    # explanation step failed. Catch that case too, not just empty/null.
    explanation_failed = not explanation or explanation.startswith("(Couldn't generate an explanation:")

    if explanation_failed:
        if explanation:
            print(f"Note: error_explanation was saved, but it's the fallback failure string:\n  {explanation}\n")
        debug_explain_error("call_groq_with_bad_key", "This call should fail.", error_message)
    else:
        print("Success - error_explanation was generated and saved correctly. Nothing to debug!")


if __name__ == "__main__":
    main()
