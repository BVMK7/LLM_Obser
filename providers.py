"""
Thin wrappers around three free LLM APIs.

Each call_*() function takes either a plain question string OR a full
conversation (`messages`, a list of {"role": "user"|"assistant"|"system", "content": str}
dicts), plus optional `temperature`/`top_p`, and returns a tuple:
    (answer_text, input_tokens, output_tokens)
so the caller can log a trace the same way regardless of which provider ran.
"""

import os
import time

from dotenv import load_dotenv

load_dotenv()


def _normalize_messages(messages):
    """Accepts a plain string (wrapped as a single user turn) or an already-built
    list of role/content dicts, so both single-turn and multi-turn callers work."""
    if isinstance(messages, str):
        return [{"role": "user", "content": messages}]
    return messages


# Observed in practice: a provider call can fail with a transient connection
# error (e.g. groq.APIConnectionError: "Connection error.") specifically from
# some CI/cloud environments while working fine from a normal dev machine —
# see https://github.com/swarmauri/swarmauri-sdk/issues/519 for another
# report of the identical symptom, root cause unconfirmed. Retrying a couple
# times absorbs a transient blip regardless of the underlying cause; anything
# else (bad API key, invalid request) isn't connection-shaped and fails fast.
def _call_with_retries(fn, max_attempts=3, backoff_seconds=1.5):
    last_exc = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            if "connection" not in type(e).__name__.lower() and "connection" not in str(e).lower():
                raise
            if attempt < max_attempts - 1:
                time.sleep(backoff_seconds * (attempt + 1))
    raise last_exc


def call_gemini(messages, model="gemini-3.5-flash", temperature=None, top_p=None):
    # google-generativeai is EOL upstream (no more updates/bug fixes); google-genai
    # is Google's supported replacement SDK and speaks a materially different API
    # (a single client + types.GenerateContentConfig instead of a GenerativeModel
    # instance), so this isn't a drop-in swap.
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    messages = _normalize_messages(messages)

    # Gemini takes any system instruction separately from the turn history.
    system_prompts = [m["content"] for m in messages if m["role"] == "system"]
    turns = [m for m in messages if m["role"] != "system"]

    # Gemini's roles are "user"/"model" (not "user"/"assistant"), and content
    # goes under "parts" instead of "content".
    contents = [
        types.Content(role="model" if m["role"] == "assistant" else "user", parts=[types.Part(text=m["content"])])
        for m in turns
    ]

    config = types.GenerateContentConfig(
        system_instruction=system_prompts[-1] if system_prompts else None,
        temperature=temperature,
        top_p=top_p,
    )

    response = _call_with_retries(lambda: client.models.generate_content(model=model, contents=contents, config=config))

    answer = response.text
    usage = response.usage_metadata
    return answer, usage.prompt_token_count, usage.candidates_token_count


def call_groq(messages, model="llama-3.1-8b-instant", temperature=None, top_p=None):
    from groq import Groq

    client = Groq(api_key=os.environ["GROQ_API_KEY"])

    kwargs = {}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if top_p is not None:
        kwargs["top_p"] = top_p

    response = _call_with_retries(lambda: client.chat.completions.create(
        model=model,
        messages=_normalize_messages(messages),
        **kwargs,
    ))

    answer = response.choices[0].message.content
    usage = response.usage
    return answer, usage.prompt_tokens, usage.completion_tokens


def call_openrouter(messages, model="google/gemma-4-26b-a4b-it:free", temperature=None, top_p=None):
    # OpenRouter speaks the OpenAI API format, so we reuse the `openai` package
    # and just point it at OpenRouter's URL instead of OpenAI's.
    from openai import OpenAI

    client = OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )

    kwargs = {}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if top_p is not None:
        kwargs["top_p"] = top_p

    response = _call_with_retries(lambda: client.chat.completions.create(
        model=model,
        messages=_normalize_messages(messages),
        **kwargs,
    ))

    answer = response.choices[0].message.content
    usage = response.usage
    return answer, usage.prompt_tokens, usage.completion_tokens


# Maps a provider name to its call function, so the example script can pick
# one at runtime with a single variable.
PROVIDERS = {
    "gemini": call_gemini,
    "groq": call_groq,
    "openrouter": call_openrouter,
}

# Which model string each provider is allowed to run, one flagged "default"
# per provider (the exact default already baked into each call_*() function
# above) plus a couple of real alternates. Playground's model picker and
# GET /models/catalog both read from this; main.py validates any
# client-supplied model string against it before passing it to a real
# provider call — never trust an arbitrary client string into a `model=` kwarg.
MODEL_CATALOG = {
    "gemini": {
        "default": "gemini-3.5-flash",
        # gemini-2.0-flash/-lite: deprecated + shut down by Google 2026-06-01.
        # gemini-2.5-flash/-lite: still listed by list_models() but this key
        # gets "no longer available to new users" 404s on both — Google is
        # phasing them out ahead of full retirement. gemini-3.5-flash/-lite are
        # confirmed working end-to-end against this key as of 2026-07-29.
        "models": ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
    },
    "groq": {
        "default": "llama-3.1-8b-instant",
        "models": ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
    },
    "openrouter": {
        "default": "google/gemma-4-26b-a4b-it:free",
        # google/gemma-2-9b-it:free was removed from OpenRouter's catalog —
        # gemma-4-31b-it:free is confirmed live via GET /api/v1/models.
        "models": ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"],
    },
}

# Published list pricing, USD per 1,000,000 tokens, confirmed 2026-07-29 against
# each provider's own pricing page/API (groq.com/pricing, ai.google.dev/gemini-api/
# docs/pricing, openrouter.ai/api/v1/models `pricing` field). This is *list* price —
# every model here is actually being called on a free tier/quota, so real spend is
# $0; showing list-price cost lets Cost & Usage report an honest "what this would
# cost at standard rates" figure instead of a meaningless hardcoded $0 for every
# request, which was actively misleading for the two paid-tier providers.
PRICING = {
    "gemini-3.5-flash": {"input": 1.50, "output": 9.00},
    "gemini-3.5-flash-lite": {"input": 0.30, "output": 2.50},
    "llama-3.1-8b-instant": {"input": 0.05, "output": 0.08},
    "llama-3.3-70b-versatile": {"input": 0.59, "output": 0.79},
    # OpenRouter's ":free" models are genuinely free — not a fallback estimate.
    "google/gemma-4-26b-a4b-it:free": {"input": 0.0, "output": 0.0},
    "google/gemma-4-31b-it:free": {"input": 0.0, "output": 0.0},
}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """List-price cost estimate for a call, in USD. Falls back to 0.0 for an
    unrecognized model rather than guessing — better an honest zero than a
    fabricated number for a model not in PRICING."""
    rates = PRICING.get(model)
    if not rates:
        return 0.0
    return (input_tokens * rates["input"] + output_tokens * rates["output"]) / 1_000_000
