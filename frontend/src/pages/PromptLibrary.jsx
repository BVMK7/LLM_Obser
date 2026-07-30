import { useEffect, useRef, useState } from "react";
import { diffWords } from "diff";
import { getPrompts, getPrompt, createPrompt, updatePrompt, deletePrompt, getPromptVersions } from "../api";
import Skeleton from "../components/Skeleton";
import CopyButton from "../components/CopyButton";
import { formatTimestamp } from "../utils";

const CATEGORIES = ["system", "user", "assistant"];

function draftPrompt() {
  return { id: null, name: "New Prompt", category: "system", content: "", tags: "" };
}

function PromptLibrarySkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4" style={{ minHeight: 420 }}>
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5">
          <Skeleton className="h-6 w-64 mb-4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}

// Same master-detail editor shape as Datasets.jsx: stale-detail clearing on
// selection change, out-of-order fetch guard, dirty-gate confirm on
// switching away, draft-then-save "new" flow, confirm-gated delete.
export default function PromptLibrary() {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState([]);
  const [diffVersionId, setDiffVersionId] = useState(null);
  const currentIdRef = useRef(null);

  const refreshList = () => getPrompts().then(setPrompts);

  useEffect(() => {
    getPrompts()
      .then((data) => {
        setPrompts(data);
        if (data.length > 0) selectPrompt(data[0].id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDiscardIfDirty = () => !dirty || window.confirm("You have unsaved changes. Discard them?");

  const selectPrompt = (id) => {
    if (!confirmDiscardIfDirty()) return;
    currentIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDirty(false);
    setVersions([]);
    setDiffVersionId(null);
    setDetailLoading(true);
    getPrompt(id)
      .then((data) => {
        if (currentIdRef.current !== id) return;
        setDetail(data);
      })
      .catch((err) => {
        if (currentIdRef.current !== id) return;
        setError(err.message);
      })
      .finally(() => {
        if (currentIdRef.current === id) setDetailLoading(false);
      });
    getPromptVersions(id)
      .then((data) => {
        if (currentIdRef.current === id) setVersions(data);
      })
      .catch(() => {});
  };

  const handleRestoreVersion = (version) => {
    if (!confirmDiscardIfDirty()) return;
    setDetail((d) => ({ ...d, name: version.name, category: version.category, content: version.content, tags: version.tags }));
    setDirty(true);
    setDiffVersionId(null);
  };

  const handleNew = () => {
    if (!confirmDiscardIfDirty()) return;
    currentIdRef.current = null;
    setSelectedId(null);
    setDetail(draftPrompt());
    setDirty(false);
  };

  const updateField = (field, value) => {
    setDetail((d) => ({ ...d, [field]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: detail.name,
        category: detail.category,
        content: detail.content,
        tags: detail.tags || null,
      };
      const saved = detail.id ? await updatePrompt(detail.id, payload) : await createPrompt(payload);
      currentIdRef.current = saved.id;
      setSelectedId(saved.id);
      setDetail(saved);
      setDirty(false);
      await refreshList();
      getPromptVersions(saved.id).then((data) => {
        if (currentIdRef.current === saved.id) setVersions(data);
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!detail?.id) return;
    if (!window.confirm(`Delete prompt "${detail.name}"? This can't be undone.`)) return;
    await deletePrompt(detail.id);
    currentIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDirty(false);
    await refreshList();
  };

  if (loading) {
    return <PromptLibrarySkeleton />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Prompt Library</h1>
        <button
          onClick={handleNew}
          className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] transition-colors"
        >
          + New Prompt
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Saved, reusable prompt templates — pick one from Playground's System Prompt dropdown instead of writing one
        from scratch every time.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="flex gap-4" style={{ minHeight: 420 }}>
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 overflow-y-auto">
          {prompts.map((p) => (
            <button
              key={p.id}
              onClick={() => selectPrompt(p.id)}
              className={`w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors ${
                p.id === selectedId ? "bg-[var(--brand-primary)]" : "hover:bg-white/5"
              }`}
            >
              <div className={`text-sm truncate ${p.id === selectedId ? "text-white" : "text-[var(--text-primary)]"}`}>
                {p.name}
              </div>
              <div
                className={`text-xs mt-0.5 flex items-center gap-2 ${
                  p.id === selectedId ? "text-white/70" : "text-[var(--text-muted)]"
                }`}
              >
                <span className="capitalize">{p.category}</span>
                <span>· used {p.usage_count}×</span>
              </div>
            </button>
          ))}
          {prompts.length === 0 && (
            <div className="text-sm text-[var(--text-muted)] p-3">No saved prompts yet. Create one to get started.</div>
          )}
        </div>

        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5 overflow-y-auto">
          {!detail ? (
            <div className="text-[var(--text-muted)]">
              {detailLoading ? "Loading…" : "Select a prompt to edit it."}
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between mb-4 gap-4">
                <div className="flex-1">
                  <input
                    value={detail.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="Prompt name"
                    className="w-full bg-transparent text-lg font-semibold text-[var(--text-primary)] focus:outline-none border-b border-transparent focus:border-[var(--border-subtle)] mb-2"
                  />
                  <div className="flex items-center gap-3">
                    <select
                      value={detail.category}
                      onChange={(e) => updateField("category", e.target.value)}
                      className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1 text-xs text-[var(--text-primary)] capitalize focus:outline-none focus:border-[var(--brand-primary)]"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      value={detail.tags || ""}
                      onChange={(e) => updateField("tags", e.target.value)}
                      placeholder="tags, comma, separated"
                      className="flex-1 bg-transparent text-xs text-[var(--text-secondary)] focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {detail.id && (
                    <button
                      onClick={handleDelete}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-[var(--brand-danger)] hover:bg-white/10 transition-colors"
                    >
                      Delete
                    </button>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={saving || !detail.name.trim() || !detail.content.trim()}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between mb-1">
                <div className="text-xs uppercase text-[var(--text-muted)]">Content</div>
                {detail.content && <CopyButton text={detail.content} />}
              </div>
              <textarea
                value={detail.content}
                onChange={(e) => updateField("content", e.target.value)}
                rows={10}
                placeholder="The system prompt text…"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)] resize-none"
              />

              {detail.id && (
                <div className="text-xs text-[var(--text-muted)] mt-3">
                  Used {detail.usage_count} time{detail.usage_count === 1 ? "" : "s"} · last updated{" "}
                  {formatTimestamp(detail.updated_at)}
                </div>
              )}

              {detail.id && versions.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[var(--border-subtle)]">
                  <div className="text-xs uppercase text-[var(--text-muted)] mb-2">
                    Version History ({versions.length})
                  </div>
                  <div className="flex flex-col gap-1">
                    {versions.map((v) => (
                      <div key={v.id}>
                        <div className="flex items-center justify-between text-xs">
                          <button
                            onClick={() => setDiffVersionId(diffVersionId === v.id ? null : v.id)}
                            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                          >
                            {formatTimestamp(v.created_at)} {diffVersionId === v.id ? "▲" : "▼"}
                          </button>
                          <button
                            onClick={() => handleRestoreVersion(v)}
                            className="text-[var(--brand-primary)] hover:underline"
                          >
                            Restore into draft
                          </button>
                        </div>
                        {diffVersionId === v.id && (
                          <div className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg p-2 mt-1 mb-1 text-xs text-[var(--text-secondary)] whitespace-pre-wrap">
                            <VersionDiff before={v.content} after={detail.content} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Word-level diff between a past version's content and the current draft —
// real content comparison, so "what changed" is exact, not summarized.
function VersionDiff({ before, after }) {
  const parts = diffWords(before || "", after || "");
  return parts.map((part, i) => (
    <span
      key={i}
      style={
        part.added
          ? { backgroundColor: "color-mix(in srgb, var(--brand-success) 20%, transparent)" }
          : part.removed
          ? { backgroundColor: "color-mix(in srgb, var(--brand-danger) 20%, transparent)", textDecoration: "line-through" }
          : undefined
      }
    >
      {part.value}
    </span>
  ));
}
