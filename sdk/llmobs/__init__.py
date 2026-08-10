"""
Minimal client SDK for the LLM Observability platform.

    from llmobs import Client

    client = Client(api_key="llmobs_...")

    @client.traced("answer_question")
    def run_agent(question):
        ...
        return answer

Nesting comes from the call stack, not from anything you configure by hand:
the outermost `@client.traced(...)` call active in a given call chain opens a
Trace; any `@client.traced(...)`-wrapped function called underneath it opens
a Span nested under that trace (and under whichever span called it, if any).

This is intentionally simple: every call is a synchronous HTTP request, and
there's no batching/retry/queueing — fine for a demo or a low-volume agent,
not yet meant for high-throughput production use (see the platform's README
for what's still on the roadmap there).
"""

import contextvars
import functools
from datetime import datetime, timezone

import requests

_stack_var = contextvars.ContextVar("llmobs_stack", default=None)


class Client:
    def __init__(self, api_key: str, base_url: str = "http://localhost:8010"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def _headers(self):
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def _post(self, path: str, body: dict):
        resp = requests.post(f"{self.base_url}{path}", json=body, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()

    def _patch(self, path: str, body: dict):
        resp = requests.patch(f"{self.base_url}{path}", json=body, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()

    def log_score(self, trace_id: str, score_name: str, score_value: float, explanation: str = None, span_id: str = None):
        """Logs a score (e.g. an LLM-judged rating) for a trace, or for one
        span within it if `span_id` is given."""
        return self._post(
            "/scores",
            {
                "trace_id": trace_id,
                "score_name": score_name,
                "score_value": score_value,
                "explanation": explanation,
                "span_id": span_id,
            },
        )

    def traced(self, name: str, session_id: str = None):
        """Use as a decorator (`@client.traced("step")`) or a context manager
        (`with client.traced("step"):`). Returns a _TracedBlock — see below.

        `session_id` groups this trace with others from the same multi-turn
        conversation; only meaningful on the outermost (trace-creating) call
        — ignored when this block ends up nested under an existing trace."""
        return _TracedBlock(self, name, session_id)


class _TracedBlock:
    def __init__(self, client: Client, name: str, session_id: str = None):
        self.client = client
        self.name = name
        self.session_id = session_id
        self._input = None
        self._output = None

    # Decorator usage: captures the wrapped function's arguments and return
    # value automatically, so a single line gets you real input/output on
    # the trace/span — no separate logging call needed. Args are captured
    # BEFORE `with self:` so __enter__ can send them immediately (see below).
    def __call__(self, fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            self._input = repr({"args": args, "kwargs": kwargs})
            with self:
                result = fn(*args, **kwargs)
                self._output = repr(result)
                return result

        return wrapper

    # Rows are created here, at __enter__, not at __exit__ — a nested
    # traced() call needs its PARENT's trace_id to exist before it can run
    # (the parent's wrapped function hasn't returned yet at that point), so
    # the row is opened immediately and finished off in __exit__ via PATCH.
    def __enter__(self):
        self.started_at = datetime.now(timezone.utc)
        stack = _stack_var.get()
        if stack is None:
            stack = []
            _stack_var.set(stack)
        self.parent = stack[-1] if stack else None
        stack.append(self)

        self.trace_id = None
        self.span_id = None
        try:
            if self.parent is None or self.parent.trace_id is None:
                trace = self.client._post(
                    "/traces",
                    {
                        "name": self.name,
                        "input": self._input,
                        "started_at": self.started_at.isoformat(),
                        "session_id": self.session_id,
                    },
                )
                self.trace_id = trace["id"]
            else:
                self.trace_id = self.parent.trace_id
                span = self.client._post(
                    "/spans",
                    {
                        "trace_id": self.trace_id,
                        "step_name": self.name,
                        "input": self._input,
                        "started_at": self.started_at.isoformat(),
                        "parent_span_id": self.parent.span_id,
                    },
                )
                self.span_id = span["id"]
        except requests.RequestException:
            # A broken observability call should never take down the
            # caller's actual agent — this block just won't get logged.
            pass
        return self

    def __exit__(self, exc_type, exc, tb):
        ended_at = datetime.now(timezone.utc)
        stack = _stack_var.get()
        if stack and stack[-1] is self:
            stack.pop()

        error_text = f"{exc_type.__name__}: {exc}" if exc_type else None

        try:
            if self.span_id is not None:
                self.client._patch(
                    f"/spans/{self.span_id}",
                    {"output": self._output, "ended_at": ended_at.isoformat(), "error": error_text},
                )
            elif self.trace_id is not None:
                self.client._patch(
                    f"/traces/{self.trace_id}",
                    {"output": self._output, "ended_at": ended_at.isoformat()},
                )
        except requests.RequestException:
            pass

        return False  # never swallow the caller's own exception
