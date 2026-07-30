"""
Basic evaluation scoring for traces — similar in spirit to what Braintrust
or Langfuse do: ask an LLM to judge a trace's answer and save the result.

Contains:
    score_trace(trace_id, question, answer)  -- the reusable scoring function
    a small example at the bottom that scores one real trace from the DB

Run the example with: python score_trace.py
Requires: the FastAPI app running at http://localhost:8010, and Postgres up.
"""

import json

import requests

from providers import PROVIDERS

API_URL = "http://localhost:8010"


def score_trace(trace_id, question, answer):
    """
    Asks an LLM to judge how relevant `answer` is to `question`, on a 0-1
    scale, then saves that score to the database via POST /scores.

    Returns the created score row (a dict with id, score_value, explanation, ...).
    """
    # 1. Build the prompt. We ask for a strict JSON reply so we can parse it
    # reliably, the same pattern main.py's own LLM-judge code uses.
    prompt = (
        "You are judging how relevant an AI assistant's answer is to the question asked. "
        f"Question: {question} "
        f"Answer: {answer} "
        "Rate the relevance on a scale from 0.0 (not relevant at all) to 1.0 (perfectly relevant). "
        "Respond with ONLY a JSON object, no other text, in this exact shape: "
        '{"score": <0.0-1.0>, "explanation": "<one sentence explaining the score>"}'
    )

    # 2. Send the prompt to the LLM. We reuse providers.py's call_groq, the
    # same free-tier wrapper the rest of this project already uses.
    call_groq = PROVIDERS["groq"]
    raw_reply, _input_tokens, _output_tokens = call_groq(prompt)

    # 3. Parse the reply. LLMs sometimes wrap JSON in a ```json ... ``` code
    # fence even when asked not to, so we strip that off before parsing.
    cleaned_reply = raw_reply.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    parsed = json.loads(cleaned_reply)
    score_value = float(parsed["score"])
    explanation = parsed["explanation"]

    # 4. Save the score by POSTing to our own API — the same pattern used
    # everywhere else in this project (create a trace/span by POSTing JSON).
    response = requests.post(
        f"{API_URL}/scores",
        json={
            "trace_id": str(trace_id),
            "score_name": "relevance",
            "score_value": score_value,
            "explanation": explanation,
        },
    )
    response.raise_for_status()
    return response.json()


# --- Example: score one existing trace from the database ---
if __name__ == "__main__":
    # 1. Fetch the list of traces from the API (most recent first).
    print("Fetching existing traces...")
    traces = requests.get(f"{API_URL}/traces").json()

    # 2. Pick the first trace that actually has both an input (question) and
    # an output (answer) — some early test traces have neither, and there's
    # nothing meaningful to score without both.
    trace = next((t for t in traces if t["input"] and t["output"]), None)
    if trace is None:
        raise SystemExit("No trace with both an input and output was found to score.")

    print(f"Scoring trace {trace['id']} ({trace['name']!r})...")
    print(f"  question: {trace['input']}")
    print(f"  answer:   {trace['output']}\n")

    # 3. Run the scoring function and print what came back.
    result = score_trace(trace["id"], trace["input"], trace["output"])

    print("Score saved:")
    print(f"  score_name:  {result['score_name']}")
    print(f"  score_value: {result['score_value']}")
    print(f"  explanation: {result['explanation']}")
