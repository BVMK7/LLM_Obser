import { useEffect, useRef, useState } from "react";
import { getDatasets, getDataset, createDataset, updateDataset, deleteDataset } from "../api";
import Skeleton from "../components/Skeleton";
import { toCSV, downloadFile, formatTimestamp } from "../utils";

function emptyCase() {
  return { id: crypto.randomUUID(), question: "", expected: "" };
}

function draftDataset() {
  return { id: null, name: "New Dataset", description: "", cases: [emptyCase()] };
}

function DatasetsSkeleton() {
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

// Master-detail editor (unlike Traces.jsx's read-only master-detail, this one
// mutates data, so it explicitly handles what a read-only view doesn't need
// to: clearing stale detail content on selection change, ignoring
// out-of-order fetch responses, gating navigation-away on unsaved changes,
// and a draft-then-save "new" flow instead of creating a row immediately).
export default function Datasets() {
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const currentIdRef = useRef(null);

  const refreshList = () => getDatasets().then(setDatasets);

  useEffect(() => {
    getDatasets()
      .then((data) => {
        setDatasets(data);
        if (data.length > 0) selectDataset(data[0].id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDiscardIfDirty = () => !dirty || window.confirm("You have unsaved changes. Discard them?");

  const selectDataset = (id) => {
    if (!confirmDiscardIfDirty()) return;
    currentIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDirty(false);
    setDetailLoading(true);
    getDataset(id)
      .then((data) => {
        if (currentIdRef.current !== id) return; // selection changed since this request fired
        // Cases created directly via the API (bypassing this page's "+ Add
        // case" button) can arrive with a null id — backfill one so every
        // case has a stable React key and can be edited/removed correctly.
        setDetail({ ...data, cases: data.cases.map((c) => ({ ...c, id: c.id || crypto.randomUUID() })) });
      })
      .catch((err) => {
        if (currentIdRef.current !== id) return;
        setError(err.message);
      })
      .finally(() => {
        if (currentIdRef.current === id) setDetailLoading(false);
      });
  };

  const handleNew = () => {
    if (!confirmDiscardIfDirty()) return;
    currentIdRef.current = null;
    setSelectedId(null);
    setDetail(draftDataset());
    setDirty(false);
  };

  const updateField = (field, value) => {
    setDetail((d) => ({ ...d, [field]: value }));
    setDirty(true);
  };

  const updateCase = (caseId, field, value) => {
    setDetail((d) => ({ ...d, cases: d.cases.map((c) => (c.id === caseId ? { ...c, [field]: value } : c)) }));
    setDirty(true);
  };

  const addCase = () => {
    setDetail((d) => ({ ...d, cases: [...d.cases, emptyCase()] }));
    setDirty(true);
  };

  const removeCase = (caseId) => {
    setDetail((d) => ({ ...d, cases: d.cases.filter((c) => c.id !== caseId) }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: detail.name,
        description: detail.description || null,
        cases: detail.cases
          .filter((c) => c.question.trim())
          .map((c) => ({ id: c.id, question: c.question, expected: c.expected?.trim() || null })),
      };
      const saved = detail.id ? await updateDataset(detail.id, payload) : await createDataset(payload);
      currentIdRef.current = saved.id;
      setSelectedId(saved.id);
      setDetail(saved);
      setDirty(false);
      await refreshList();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!detail?.id) return;
    if (!window.confirm(`Delete dataset "${detail.name}"? This can't be undone.`)) return;
    await deleteDataset(detail.id);
    currentIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDirty(false);
    await refreshList();
  };

  const handleExportCSV = () => {
    if (!detail) return;
    downloadFile(
      `${detail.name || "dataset"}.csv`,
      toCSV(detail.cases.map((c) => ({ question: c.question, expected: c.expected || "" }))),
      "text/csv"
    );
  };

  if (loading) {
    return <DatasetsSkeleton />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Datasets</h1>
        <button
          onClick={handleNew}
          className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] transition-colors"
        >
          + New Dataset
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Saved, reusable sets of eval test cases — load one into Evaluation instead of retyping cases every run.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="flex gap-4" style={{ minHeight: 420 }}>
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 overflow-y-auto">
          {datasets.map((d) => (
            <button
              key={d.id}
              onClick={() => selectDataset(d.id)}
              className={`w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors ${
                d.id === selectedId ? "bg-[var(--brand-primary)]" : "hover:bg-white/5"
              }`}
            >
              <div className={`text-sm truncate ${d.id === selectedId ? "text-white" : "text-[var(--text-primary)]"}`}>
                {d.name}
              </div>
              <div className={`text-xs mt-0.5 ${d.id === selectedId ? "text-white/70" : "text-[var(--text-muted)]"}`}>
                {d.case_count} case{d.case_count === 1 ? "" : "s"} · {formatTimestamp(d.updated_at)}
              </div>
            </button>
          ))}
          {datasets.length === 0 && (
            <div className="text-sm text-[var(--text-muted)] p-3">No datasets yet. Create one to get started.</div>
          )}
        </div>

        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5 overflow-y-auto">
          {!detail ? (
            <div className="text-[var(--text-muted)]">
              {detailLoading ? "Loading…" : "Select a dataset to edit it."}
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between mb-4 gap-4">
                <div className="flex-1">
                  <input
                    value={detail.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="Dataset name"
                    className="w-full bg-transparent text-lg font-semibold text-[var(--text-primary)] focus:outline-none border-b border-transparent focus:border-[var(--border-subtle)] mb-2"
                  />
                  <input
                    value={detail.description || ""}
                    onChange={(e) => updateField("description", e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full bg-transparent text-sm text-[var(--text-secondary)] focus:outline-none"
                  />
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={handleExportCSV}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 transition-colors"
                  >
                    Export CSV
                  </button>
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
                    disabled={saving || !detail.name.trim()}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              <div className="text-sm font-medium text-[var(--text-primary)] mb-2">
                Cases ({detail.cases.length})
              </div>
              <div className="flex flex-col gap-2 mb-3">
                {detail.cases.map((c) => (
                  <div key={c.id} className="flex gap-2 items-start">
                    <input
                      value={c.question}
                      onChange={(e) => updateCase(c.id, "question", e.target.value)}
                      placeholder="Question"
                      className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                    />
                    <input
                      value={c.expected || ""}
                      onChange={(e) => updateCase(c.id, "expected", e.target.value)}
                      placeholder="Expected keyword (optional)"
                      className="w-56 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                    />
                    <button
                      onClick={() => removeCase(c.id)}
                      disabled={detail.cases.length === 1}
                      className="px-2 py-2 text-[var(--text-muted)] hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove case"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addCase}
                className="px-3 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] text-sm hover:bg-white/10 transition-colors"
              >
                + Add case
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
