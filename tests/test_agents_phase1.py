"""
Integration tests for AgentOps Phase 1: agent identity/auto-registration,
shared memory, agent-to-agent messaging, the per-agent cost dashboard, and
the SSE live session status stream.

Run with the backend + Postgres already up and migrated:
    pytest tests/ -v
"""

import json
import os
import time
import uuid
from datetime import datetime, timezone

import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8010")


def _post(path, headers, body=None):
    resp = requests.post(f"{BACKEND_URL}{path}", headers=headers, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _get(path, headers, params=None):
    resp = requests.get(f"{BACKEND_URL}{path}", headers=headers, params=params or {})
    resp.raise_for_status()
    return resp.json()


# --- Agent identity ---

def test_agent_auto_registers_via_trace(api_headers):
    agent_name = f"ResearchAgent-{uuid.uuid4().hex[:8]}"
    trace = _post("/traces", api_headers, {"name": "research_task", "agent_name": agent_name})
    assert trace["agent_id"] is not None

    agents = _get("/agents", api_headers)
    matching = [a for a in agents if a["name"] == agent_name]
    assert len(matching) == 1
    assert matching[0]["id"] == trace["agent_id"]

    # A second trace under the SAME agent name must resolve to the SAME
    # agent_id, not mint a duplicate — this is the find-or-create contract.
    trace2 = _post("/traces", api_headers, {"name": "research_task_2", "agent_name": agent_name})
    assert trace2["agent_id"] == trace["agent_id"]


def test_trace_without_agent_name_is_unaffected(api_headers):
    trace = _post("/traces", api_headers, {"name": "no_agent_trace"})
    assert trace["agent_id"] is None


# --- Shared memory ---

def test_memory_upsert_and_read(api_headers):
    agent_name = f"MemoryAgent-{uuid.uuid4().hex[:8]}"
    _post("/agents/memory", api_headers, {
        "agent_name": agent_name, "scope": "long_term", "key": "found_sources", "value": ["a", "b"],
    })
    entries = _get("/agents/memory", api_headers, {"agent_name": agent_name})
    assert len(entries) == 1
    assert entries[0]["value"] == ["a", "b"]

    # Writing the SAME key again must update it in place, not duplicate it.
    _post("/agents/memory", api_headers, {
        "agent_name": agent_name, "scope": "long_term", "key": "found_sources", "value": ["a", "b", "c"],
    })
    entries = _get("/agents/memory", api_headers, {"agent_name": agent_name})
    assert len(entries) == 1
    assert entries[0]["value"] == ["a", "b", "c"]


def test_memory_scoped_by_session(api_headers):
    agent_name = f"SessionMemAgent-{uuid.uuid4().hex[:8]}"
    session_a, session_b = str(uuid.uuid4()), str(uuid.uuid4())

    _post("/agents/memory", api_headers, {
        "agent_name": agent_name, "scope": "short_term", "key": "turn", "value": "A", "session_id": session_a,
    })
    _post("/agents/memory", api_headers, {
        "agent_name": agent_name, "scope": "short_term", "key": "turn", "value": "B", "session_id": session_b,
    })

    entries_a = _get("/agents/memory", api_headers, {"agent_name": agent_name, "session_id": session_a})
    entries_b = _get("/agents/memory", api_headers, {"agent_name": agent_name, "session_id": session_b})
    assert [e["value"] for e in entries_a] == ["A"]
    assert [e["value"] for e in entries_b] == ["B"]


def test_memory_ttl_expiry(api_headers):
    # ttl_seconds=5 (not 1) — a real HTTP write-then-read round trip can
    # itself eat the better part of a second under load, so a 1s TTL was
    # flaky (the immediate-presence check could lose the race against
    # expiry). 5s comfortably outlasts request latency; the test still only
    # waits ~6s total.
    agent_name = f"TTLAgent-{uuid.uuid4().hex[:8]}"
    _post("/agents/memory", api_headers, {
        "agent_name": agent_name, "scope": "short_term", "key": "scratch", "value": "temp", "ttl_seconds": 5,
    })
    # Present immediately.
    assert len(_get("/agents/memory", api_headers, {"agent_name": agent_name})) == 1

    time.sleep(6)
    # Excluded once expired — GET filters expires_at IS NULL OR expires_at > now().
    assert _get("/agents/memory", api_headers, {"agent_name": agent_name}) == []


def test_memory_delete(api_headers):
    agent_name = f"DeleteAgent-{uuid.uuid4().hex[:8]}"
    _post("/agents/memory", api_headers, {
        "agent_name": agent_name, "scope": "long_term", "key": "note", "value": "x",
    })
    assert len(_get("/agents/memory", api_headers, {"agent_name": agent_name})) == 1

    resp = requests.delete(
        f"{BACKEND_URL}/agents/memory", headers=api_headers,
        params={"agent_name": agent_name, "scope": "long_term", "key": "note"},
    )
    resp.raise_for_status()
    assert _get("/agents/memory", api_headers, {"agent_name": agent_name}) == []


# --- Agent-to-agent messaging ---

def test_message_send_and_inbox_read_marking(api_headers):
    sender, recipient = f"Sender-{uuid.uuid4().hex[:8]}", f"Recipient-{uuid.uuid4().hex[:8]}"
    message = _post("/agents/messages", api_headers, {
        "from_agent": sender, "to_agent": recipient, "content": {"task": "summarize"},
    })
    assert message["read_at"] is None

    inbox = _get("/agents/messages", api_headers, {"agent_name": recipient})
    assert len(inbox) == 1
    assert inbox[0]["content"] == {"task": "summarize"}

    # Marking read removes it from the default (unread_only=true) view.
    resp = requests.patch(f"{BACKEND_URL}/agents/messages/{message['id']}", headers=api_headers, json={"read": True})
    resp.raise_for_status()
    assert _get("/agents/messages", api_headers, {"agent_name": recipient}) == []
    # ...but it's still there if the caller asks for everything.
    all_messages = _get("/agents/messages", api_headers, {"agent_name": recipient, "unread_only": False})
    assert len(all_messages) == 1


def test_message_broadcast_reaches_every_agent(api_headers):
    sender = f"Broadcaster-{uuid.uuid4().hex[:8]}"
    listener_a, listener_b = f"ListenerA-{uuid.uuid4().hex[:8]}", f"ListenerB-{uuid.uuid4().hex[:8]}"
    # Register both listeners first so they exist as agents to check inboxes for.
    _post("/agents/messages", api_headers, {"from_agent": listener_a, "to_agent": sender, "content": "hi"})
    _post("/agents/messages", api_headers, {"from_agent": listener_b, "to_agent": sender, "content": "hi"})

    _post("/agents/messages", api_headers, {"from_agent": sender, "to_agent": None, "content": "broadcast!"})

    inbox_a = _get("/agents/messages", api_headers, {"agent_name": listener_a})
    inbox_b = _get("/agents/messages", api_headers, {"agent_name": listener_b})
    assert any(m["content"] == "broadcast!" for m in inbox_a)
    assert any(m["content"] == "broadcast!" for m in inbox_b)


# --- Per-agent cost dashboard ---

def test_agent_costs_aggregation(api_headers):
    agent_x, agent_y = f"AgentX-{uuid.uuid4().hex[:8]}", f"AgentY-{uuid.uuid4().hex[:8]}"
    now = datetime.now(timezone.utc).isoformat()

    for cost in (1.0, 2.0):
        _post("/traces", api_headers, {
            "name": "task", "agent_name": agent_x, "cost": cost, "total_tokens": 100,
            "ended_at": now,
        })
    _post("/traces", api_headers, {"name": "task", "agent_name": agent_y, "cost": 5.0, "total_tokens": 50})
    _post("/traces", api_headers, {"name": "unattributed_task", "cost": 0.5})  # no agent_name

    summaries = {s["agent_name"]: s for s in _get("/agents/costs", api_headers)}
    assert summaries[agent_x]["trace_count"] == 2
    assert summaries[agent_x]["total_cost"] == 3.0
    assert summaries[agent_x]["total_tokens"] == 200
    assert summaries[agent_y]["total_cost"] == 5.0
    assert summaries["Unattributed"]["total_cost"] == 0.5

    # Sorted by cost descending.
    names_in_order = [s["agent_name"] for s in _get("/agents/costs", api_headers)]
    assert names_in_order.index(agent_y) < names_in_order.index(agent_x)


# --- Live session status (SSE) ---

def test_session_stream_yields_status_and_halts(project, api_headers, admin_headers):
    # ProjectUpdate.name is required even when only setting a threshold —
    # fetch the project's current name rather than assume/overwrite it.
    current = next(p for p in _get("/projects", admin_headers) if p["id"] == project["id"])
    resp = requests.patch(
        f"{BACKEND_URL}/projects/{project['id']}", headers=admin_headers,
        json={"name": current["name"], "max_session_steps": 2},
    )
    resp.raise_for_status()

    session_id = str(uuid.uuid4())
    trace = _post("/traces", api_headers, {"name": "streamed_session", "session_id": session_id})
    for _ in range(3):  # 3 spans > max_session_steps=2
        _post("/spans", api_headers, {"trace_id": trace["id"], "step_name": "step"})

    frames = []
    with requests.get(
        f"{BACKEND_URL}/sessions/{session_id}/stream", headers=api_headers, stream=True, timeout=30
    ) as stream_resp:
        stream_resp.raise_for_status()
        for raw_line in stream_resp.iter_lines(decode_unicode=True):
            if not raw_line or not raw_line.startswith("data: "):
                continue
            frame = json.loads(raw_line[len("data: "):])
            frames.append(frame)
            if frame["halted"] or len(frames) > 5:
                break

    assert frames, "expected at least one status frame from the stream"
    assert frames[-1]["halted"] is True
    assert frames[-1]["step_count"] == 3
