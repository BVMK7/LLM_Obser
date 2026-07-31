import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getApiKey, setApiKey, getProjects, createProject, createApiKey, deleteProject } from "../api";
import CopyButton from "./CopyButton";

// GET /projects never returns a key (only shown once, at creation) — so the
// frontend keeps its own local registry of {projectId: {name, apiKey}} to
// remember which key belongs to which project. This is a demo-scope
// convenience, not a real credential store: it lives in localStorage on
// this one browser, same as the active-key selection itself.
const REGISTRY_KEY = "llmobs_known_projects";
const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_API_KEY = "llmobs_dev_default_do_not_use_in_prod";

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

  const refreshProjects = () =>
    getProjects()
      .then((list) => {
        setProjects(list);
        const registry = loadRegistry();
        if (!registry[DEFAULT_PROJECT_ID]) {
          const defaultProject = list.find((p) => p.id === DEFAULT_PROJECT_ID);
          if (defaultProject) {
            registry[DEFAULT_PROJECT_ID] = { name: defaultProject.name, apiKey: DEFAULT_API_KEY };
            saveRegistry(registry);
          }
        }
        const currentKey = getApiKey();
        const match = Object.entries(loadRegistry()).find(([, v]) => v.apiKey === currentKey);
        setActiveId(match ? match[0] : DEFAULT_PROJECT_ID);
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

    const registry = loadRegistry();
    const entry = registry[value];
    if (entry) {
      setApiKey(entry.apiKey);
      window.location.reload();
      return;
    }
    // No key on file for this project (e.g. it was created by an external
    // SDK script, not through this dropdown) — mint a fresh one so viewing
    // its data doesn't depend on however it happened to be created.
    const project = projects.find((p) => p.id === value);
    createApiKey(value).then((issued) => {
      registry[value] = { name: project ? project.name : value, apiKey: issued.api_key };
      saveRegistry(registry);
      setApiKey(issued.api_key);
      window.location.reload();
    });
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
    if (activeId === DEFAULT_PROJECT_ID) return;
    const project = projects.find((p) => p.id === activeId);
    const label = project ? project.name : "this project";
    if (!window.confirm(`Delete "${label}" and everything in it (traces, prompts, experiments, etc.)? This cannot be undone.`)) {
      return;
    }
    deleteProject(activeId).then(() => {
      const registry = loadRegistry();
      delete registry[activeId];
      saveRegistry(registry);
      setApiKey(DEFAULT_API_KEY);
      window.location.reload();
    });
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
        <button
          onClick={handleDelete}
          disabled={activeId === DEFAULT_PROJECT_ID}
          title={activeId === DEFAULT_PROJECT_ID ? "The Default Project can't be deleted" : "Delete this project"}
          className="w-7 h-7 flex items-center justify-center border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--brand-danger)] hover:border-[var(--brand-danger)]/50 disabled:opacity-30 disabled:hover:text-[var(--text-muted)] disabled:hover:border-[var(--border-subtle)] transition-colors text-xs"
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
          <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-6 w-[28rem]">
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
