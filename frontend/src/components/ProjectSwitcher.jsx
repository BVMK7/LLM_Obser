import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { getApiKey, setApiKey, getProjects, createProject, createApiKey, deleteProject, API_BASE } from "../api";
import CopyButton from "./CopyButton";

// Not a standalone file to run — an instructional PROMPT meant to be pasted
// straight into an AI coding assistant (Claude Code, Copilot, Cursor, ...)
// so IT wires the logging into the recipient's actual existing codebase,
// rather than handing a human a file to manually copy in and wrap things
// with themselves.
function buildIntegrationPrompt(apiKey, projectName) {
  return `Add LLM observability logging to this project so every real agent/LLM call gets tracked on our dashboard (project: ${projectName}).

1. Run: pip install requests

2. Add a new file to this project called llmobs_logging.py with exactly this content:

import requests
from datetime import datetime, timezone

LLMOBS_API_KEY = "${apiKey}"
LLMOBS_BASE_URL = "${API_BASE}"
HEADERS = {"X-API-Key": LLMOBS_API_KEY}


def log_step(name, fn, *args, **kwargs):
    """Wraps a function call — logs it as a trace, then calls the real
    function and records what it returned."""
    create_resp = requests.post(
        f"{LLMOBS_BASE_URL}/traces",
        json={"name": name, "input": repr({"args": args, "kwargs": kwargs})},
        headers=HEADERS,
        timeout=30,
    )
    if not create_resp.ok:
        return fn(*args, **kwargs)

    trace = create_resp.json()
    result = fn(*args, **kwargs)

    requests.patch(
        f"{LLMOBS_BASE_URL}/traces/{trace['id']}",
        json={"output": str(result), "ended_at": datetime.now(timezone.utc).isoformat()},
        headers=HEADERS,
        timeout=30,
    )
    return result

3. Find every place in this codebase that calls an LLM or runs a meaningful agent step, and wrap that call site with log_step(...) instead of calling it directly. For example, change:
    answer = call_llm(prompt)
to:
    from llmobs_logging import log_step
    answer = log_step("call_llm", call_llm, prompt)

Do not change the logic inside the wrapped function itself — only wrap the call site. If there are multiple real steps (e.g. retrieval, then reasoning, then generation), wrap each one separately rather than only the final result.`;
}

// GET /projects never returns a key (only shown once, at creation) — so the
// frontend keeps its own local registry of {projectId: {name, apiKey}} to
// remember which key belongs to which project. This is a demo-scope
// convenience, not a real credential store: it lives in localStorage on
// this one browser, same as the active-key selection itself.
const REGISTRY_KEY = "llmobs_known_projects";

function loadRegistry() {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY)) || {};
  } catch {
    return {};
  }
}

function saveRegistry(registry) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
}

// This is the visual proof of tenant isolation during a demo: switching the
// dropdown swaps the active API key and reloads, so every page's data comes
// back scoped to a different project.
export default function ProjectSwitcher() {
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  // null | {stage: "name"} | {stage: "created", id, name, apiKey}
  const [modal, setModal] = useState(null);
  const [newName, setNewName] = useState("");

  // Activates a project the caller has genuinely confirmed is in `list` —
  // reuses a known key if one's on file, otherwise mints a fresh one (e.g.
  // the project was created by an external SDK script, not this dropdown,
  // or this user has never opened it before). Always ends by reloading so
  // every page's data-plane fetch picks up the newly-set key.
  const activateProject = (projectId, list) => {
    const registry = loadRegistry();
    const entry = registry[projectId];
    if (entry) {
      setApiKey(entry.apiKey);
      window.location.reload();
      return;
    }
    const project = list.find((p) => p.id === projectId);
    createApiKey(projectId).then((issued) => {
      registry[projectId] = { name: project ? project.name : projectId, apiKey: issued.api_key };
      saveRegistry(registry);
      setApiKey(issued.api_key);
      window.location.reload();
    });
  };

  const refreshProjects = () =>
    getProjects()
      .then((list) => {
        setProjects(list);
        if (list.length === 0) return;

        const currentKey = getApiKey();
        const match = Object.entries(loadRegistry()).find(([, v]) => v.apiKey === currentKey);
        // The matched project only counts if it's actually one this user is
        // a member of — GET /projects is scoped to real membership now, so
        // a stale key for some other project (e.g. left over from switching
        // backends, or a project this account was removed from) must not be
        // trusted just because it happens to still be a valid key somewhere.
        if (match && list.some((p) => p.id === match[0])) {
          setActiveId(match[0]);
          return;
        }
        // No valid match — fall back to a project this user actually has,
        // rather than a hardcoded id that may not be theirs, and make sure
        // the active key genuinely corresponds to what's displayed.
        activateProject(list[0].id, list);
      })
      .catch(() => {});

  useEffect(() => {
    refreshProjects();
  }, []);

  const handleSelect = (e) => {
    const value = e.target.value;
    if (value === "__new__") {
      setNewName("");
      setModal({ stage: "name" });
      return;
    }
    activateProject(value, projects);
  };

  const submitNewProject = () => {
    const name = newName.trim();
    if (!name) return;
    createProject({ name }).then((created) => {
      const registry = loadRegistry();
      registry[created.id] = { name: created.name, apiKey: created.api_key };
      saveRegistry(registry);
      setModal({ stage: "created", id: created.id, name: created.name, apiKey: created.api_key });
    });
  };

  const switchToCreated = () => {
    setApiKey(modal.apiKey);
    window.location.reload();
  };

  const handleDelete = () => {
    const project = projects.find((p) => p.id === activeId);
    const label = project ? project.name : "this project";
    if (!window.confirm(`Delete "${label}" and everything in it (traces, prompts, experiments, etc.)? This cannot be undone.`)) {
      return;
    }
    // No hardcoded "protected project" id here — the backend is the real
    // authority on whether a project can be deleted (it rejects the seeded
    // Default Project); a rejection just surfaces as a real error message.
    deleteProject(activeId)
      .then(() => {
        const registry = loadRegistry();
        delete registry[activeId];
        saveRegistry(registry);
        // Clear the key rather than reset to any particular one — the next
        // load's refreshProjects() picks a real project this user belongs
        // to, whatever that happens to be.
        setApiKey("");
        window.location.reload();
      })
      .catch((err) => window.alert(err.message));
  };

  return (
    <>
      <div className="hidden lg:flex items-center gap-1">
        <select
          value={activeId || ""}
          onChange={handleSelect}
          title="Switch which project's data you're viewing"
          className="bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__new__">+ New project…</option>
        </select>
        {activeId && (
          <Link
            to={`/projects/${activeId}/settings`}
            title="Project settings — members, API keys, billing"
            className="w-7 h-7 flex items-center justify-center border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-xs"
          >
            ⚙
          </Link>
        )}
        <button
          onClick={handleDelete}
          title="Delete this project"
          className="w-7 h-7 flex items-center justify-center border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--brand-danger)] hover:border-[var(--brand-danger)]/50 transition-colors text-xs"
        >
          🗑
        </button>
      </div>

      {modal?.stage === "name" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setModal(null)}>
          <div
            className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-6 w-96"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">New project</h3>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitNewProject()}
              placeholder="e.g. a customer's name"
              className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setModal(null)}
                className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={submitNewProject}
                className="px-3 py-1.5 text-sm bg-[var(--brand-primary)] text-white hover:opacity-90"
              >
                Create
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {modal?.stage === "created" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-6 w-[34rem] max-h-[85vh] overflow-y-auto">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Project "{modal.name}" created</h3>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Copy this API key now — it won't be shown again. Use it in the SDK's <code>Client(api_key=...)</code>.
            </p>
            <div className="flex items-center gap-2 bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2">
              <input
                readOnly
                value={modal.apiKey}
                onFocus={(e) => e.target.select()}
                className="flex-1 bg-transparent text-xs text-[var(--text-primary)] focus:outline-none font-mono"
              />
              <CopyButton text={modal.apiKey} />
            </div>

            <div className="flex items-center justify-between mt-5 mb-1">
              <p className="text-xs text-[var(--text-muted)]">
                Or copy this prompt and paste it straight into Claude Code, Copilot, or any AI coding
                assistant — key and URL already filled in, it wires the logging into your actual codebase itself.
              </p>
              <CopyButton text={buildIntegrationPrompt(modal.apiKey, modal.name)} className="shrink-0 ml-2" />
            </div>
            <pre className="bg-[var(--bg-input)] border border-[var(--border-subtle)] p-3 text-[10px] text-[var(--text-secondary)] font-mono overflow-x-auto max-h-56 overflow-y-auto whitespace-pre">
              {buildIntegrationPrompt(modal.apiKey, modal.name)}
            </pre>

            <div className="flex justify-end mt-4">
              <button
                onClick={switchToCreated}
                className="px-3 py-1.5 text-sm bg-[var(--brand-primary)] text-white hover:opacity-90"
              >
                Done — switch to this project
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
