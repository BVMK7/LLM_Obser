"""
One-shot diagnostic: reproduce providers.call_groq's exact call path and
print the FULL exception chain (not just str(e), which the groq/openai SDK
collapses to a generic "Connection error." that hides the real cause).
Run directly in CI to see what's actually failing underneath.
"""

import os
import sys
import traceback

from dotenv import load_dotenv

load_dotenv()

print("python:", sys.version)

import groq
import httpx

print("groq package version:", getattr(groq, "__version__", "unknown"))
print("httpx package version:", getattr(httpx, "__version__", "unknown"))

key = os.environ.get("GROQ_API_KEY", "")
print("GROQ_API_KEY present:", bool(key), "length:", len(key))

print("\n--- raw httpx.get to api.groq.com (bypasses the groq SDK entirely) ---")
try:
    r = httpx.get("https://api.groq.com/openai/v1/models", headers={"Authorization": f"Bearer {key}"}, timeout=15)
    print("httpx status:", r.status_code)
    print("httpx body:", r.text[:300])
except Exception:
    print("httpx.get raised:")
    traceback.print_exc()

print("\n--- groq SDK client.chat.completions.create (the actual call path that's been failing) ---")
try:
    client = groq.Groq(api_key=key)
    response = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": "Say OK."}],
    )
    print("SUCCESS:", response.choices[0].message.content)
except Exception as e:
    print("groq SDK raised:", type(e).__name__, "-", e)
    print("\nFull traceback:")
    traceback.print_exc()
    # Walk the exception chain — groq/openai SDKs often wrap the real httpx
    # exception as __cause__, which str(e) alone doesn't show.
    cause = e.__cause__
    depth = 0
    while cause is not None and depth < 5:
        print(f"\n--- caused by (depth {depth}): {type(cause).__name__}: {cause} ---")
        cause = cause.__cause__
        depth += 1
