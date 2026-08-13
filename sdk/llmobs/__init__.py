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

Guardrails — call `client.check_injection(trace_id, text)` on any tool
result or other untrusted text *before* letting the agent act on it. If the
returned dict's "flagged" is True, stop and surface "explanation" to
whoever's watching instead of proceeding — don't feed the text to the agent.

Kill-switch — in an agent loop using `session_id=` on `client.traced(...)`,
call `client.session_status(session_id)` before each step/tool call. If the
returned dict's "halted" is True, stop the agent and surface "reason"
instead of continuing — the thresholds live on the project (admin-set), not
something this SDK call can raise itself.

Policy engine — call `client.check_policy(model=..., tool_name=...,
estimated_cost=...)` before a model/tool call to check it against
admin-configured rules (blocked models, blocked tools, per-call cost caps).
Advisory, like the kill-switch: if "allowed" is False, stop and surface
"violations" instead of proceeding.

Agent memory & messaging — pass `agent_name=` to `client.traced(...)` to
attribute a trace to a named agent (auto-registered on first use; the same
name always resolves to the same agent). `client.remember`/`recall`/
`forget` are a simple key-value store, scoped short-term (with a TTL) or
long-term, optionally to one `session_id`. `client.send_message`/
`get_messages` are a durable inbox between agents in the same project
(`to_agent=None` broadcasts to every agent).
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

    def _get(self, path: str, params: dict = None):
        resp = requests.get(f"{self.base_url}{path}", params=params, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, body: dict):
        resp = requests.post(f"{self.base_url}{path}", json=body, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()

    def _patch(self, path: str, body: dict):
        resp = requests.patch(f"{self.base_url}{path}", json=body, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()

    def _delete(self, path: str, params: dict = None):
        resp = requests.delete(f"{self.base_url}{path}", params=params, headers=self._headers(), timeout=30)
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

    def session_status(self, session_id: str) -> dict:
        """Kill-switch check — call this before each step/tool call in an
        agent loop that's using session_id= on traced(). Returns
        {"session_id", "step_count", "total_cost", "elapsed_seconds",
        "halted": bool, "reason": str | None}; if "halted" is True, stop the
        agent and surface "reason" instead of continuing. Once halted it
        stays halted (latches server-side) — there's no way to un-halt from
        here."""
        return self._get(f"/sessions/{session_id}/status")

    def check_injection(self, trace_id: str, text: str, span_id: str = None, scorer_slug: str = "prompt-injection-guard"):
        """Synchronous safety gate — call this on any tool result or other
        untrusted text BEFORE letting the agent act on it. Blocks on the
        judge call (unlike log_score, which just records a value after the
        fact). Returns {"flagged": bool, "score": float | None,
        "explanation": str}; if "flagged" is True, stop and surface
        "explanation" instead of proceeding."""
        return self._post(
            "/guardrails/check",
            {
                "trace_id": trace_id,
                "span_id": span_id,
                "scorer_slug": scorer_slug,
                "text": text,
            },
        )

    def check_policy(self, trace_id: str = None, model: str = None, tool_name: str = None, estimated_cost: float = None) -> dict:
        """Advisory policy check — call this before letting the agent call a
        model/tool or before an expensive step, matching check_injection's
        shape. Pure rule comparison, no LLM call. Returns {"allowed": bool,
        "violations": [str]}; if "allowed" is False, stop and surface
        "violations" instead of proceeding. Pass only whichever of
        model/tool_name/estimated_cost is relevant to this check."""
        return self._post(
            "/policies/check",
            {
                "trace_id": trace_id,
                "model": model,
                "tool_name": tool_name,
                "estimated_cost": estimated_cost,
            },
        )

    def list_agents(self) -> list:
        """Every agent registered in this project so far (auto-registered
        via agent_name on traced()/remember()/send_message())."""
        return self._get("/agents")

    def remember(self, agent_name: str, key: str, value, scope: str = "short_term", session_id: str = None, ttl_seconds: int = None):
        """Writes (or updates in place) one key in an agent's shared memory.
        `scope="short_term"` + `ttl_seconds` expires the entry automatically;
        `scope="long_term"` persists it. Scope to one conversation with
        `session_id`, or omit it for memory that persists across sessions."""
        return self._post(
            "/agents/memory",
            {
                "agent_name": agent_name,
                "scope": scope,
                "key": key,
                "value": value,
                "session_id": session_id,
                "ttl_seconds": ttl_seconds,
            },
        )

    def recall(self, agent_name: str, scope: str = None, session_id: str = None) -> list:
        """Reads back an agent's memory entries (already-expired short_term
        entries are excluded server-side). Filter by scope/session_id, or
        omit both for everything still live."""
        params = {"agent_name": agent_name}
        if scope is not None:
            params["scope"] = scope
        if session_id is not None:
            params["session_id"] = session_id
        return self._get("/agents/memory", params)

    def forget(self, agent_name: str, scope: str, key: str, session_id: str = None):
        """Deletes one memory entry. No-op (not an error) if it never
        existed or already expired."""
        params = {"agent_name": agent_name, "scope": scope, "key": key}
        if session_id is not None:
            params["session_id"] = session_id
        return self._delete("/agents/memory", params)

    def send_message(self, from_agent: str, to_agent: str = None, content=None, session_id: str = None):
        """Sends a message into another agent's inbox (both agents are
        auto-registered if new). `to_agent=None` broadcasts to every agent
        in the project."""
        return self._post(
            "/agents/messages",
            {"from_agent": from_agent, "to_agent": to_agent, "content": content, "session_id": session_id},
        )

    def get_messages(self, agent_name: str, unread_only: bool = True) -> list:
        """Reads an agent's inbox — unread only by default. Pair with
        mark_message_read() once a message has been handled."""
        return self._get("/agents/messages", {"agent_name": agent_name, "unread_only": unread_only})

    def mark_message_read(self, message_id: str):
        return self._patch(f"/agents/messages/{message_id}", {"read": True})

    def agent_costs(self, window_minutes: int = None) -> list:
        """Per-agent cost/token/latency totals, sorted highest-cost first,
        with an "Unattributed" bucket for traces that never set agent_name.
        Omit window_minutes for all-time totals."""
        params = {"window_minutes": window_minutes} if window_minutes is not None else None
        return self._get("/agents/costs", params)

    def traced(self, name: str, session_id: str = None, agent_name: str = None):
        """Use as a decorator (`@client.traced("step")`) or a context manager
        (`with client.traced("step"):`). Returns a _TracedBlock — see below.

        `session_id` groups this trace with others from the same multi-turn
        conversation; `agent_name` attributes it to a named agent (see the
        module docstring). Both are only meaningful on the outermost
        (trace-creating) call — ignored when this block ends up nested under
        an existing trace."""
        return _TracedBlock(self, name, session_id, agent_name)


class _TracedBlock:
    def __init__(self, client: Client, name: str, session_id: str = None, agent_name: str = None):
        self.client = client
        self.name = name
        self.session_id = session_id
        self.agent_name = agent_name
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
                        "agent_name": self.agent_name,
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
