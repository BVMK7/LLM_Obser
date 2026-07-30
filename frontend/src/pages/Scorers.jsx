import { useEffect, useRef, useState } from "react";
import { getScorers, getScorer, createScorer, updateScorer, deleteScorer } from "../api";
import Skeleton from "../components/Skeleton";
import { formatTimestamp } from "../utils";

// Choices are edited as an array with a stable id, not as the {label: value}
// object the API uses — identity-by-id means renaming a label can never
// silently collide with and overwrite another choice mid-edit (see
// choicesToMap below, where uniqueness is actually enforced, at Save time).
function draftScorer() {
  return {
    id: null,
    name: "New Scorer",
    description: "",
    prompt_template: "Question: {{input}}\nExpected: {{expected}}\nAnswer: {{output}}\n\n<criteria to judge>",
    choices: [
      { id: crypto.randomUUID(), label: "Yes", value: 1.0 },
      { id: crypto.randomUUID(), label: "No", value: 0.0 },
    ],
    pass_threshold: 0.7,
  };
}

function choiceScoresToChoices(choiceScores) {
  return Object.entries(choiceScores).map(([label, value]) => ({ id: crypto.randomUUID(), label, value }));
}

// Returns { map } on success, or { error } if two choices share a label —
// duplicate labels can't become a JSON object key each, so this has to be
// caught explicitly rather than silently keeping whichever one "wins".
function choicesToMap(choices) {
  const map = {};
  for (const c of choices) {
    const label = c.label.trim();
    if (!label) return { error: "Every choice needs a label." };
    if (label in map) return { error: `Duplicate choice label: "${label}"` };
    map[label] = Number(c.value);
  }
  return { map };
}

function ScorersSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-96 mb-6" />
      <div className="flex gap-4" style={{ minHeight: 420 }}>
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
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

// A Scorer is a user-defined LLM-judge rubric: a prompt template (with
// {{input}}/{{output}}/{{expected}} placeholders) plus a mapping from the
// judge's chosen label to a 0-1 score. Same master-detail CRUD editor
// pattern as Datasets/PromptLibrary — see Datasets.jsx for the stale-detail-
// clearing / dirty-tracking rationale, reused verbatim here.
export default function Scorers() {
  const [scorers, setScorers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const currentIdRef = useRef(null);

  const refreshList = () => getScorers().then(setScorers);

  useEffect(() => {
    getScorers()
      .then((data) => {
        setScorers(data);
        if (data.length > 0) selectScorer(data[0].id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDiscardIfDirty = () => !dirty || window.confirm("You have unsaved changes. Discard them?");

  const selectScorer = (id) => {
    if (!confirmDiscardIfDirty()) return;
    currentIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDirty(false);
    setDetailLoading(true);
    getScorer(id)
      .then((data) => {
        if (currentIdRef.current !== id) return;
        setDetail({ ...data, choices: choiceScoresToChoices(data.choice_scores) });
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
    setDetail(draftScorer());
    setDirty(false);
  };

  const updateField = (field, value) => {
    setDetail((d) => ({ ...d, [field]: value }));
    setDirty(true);
  };

  const updateChoiceLabel = (id, newLabel) => {
    setDetail((d) => ({ ...d, choices: d.choices.map((c) => (c.id === id ? { ...c, label: newLabel } : c)) }));
    setDirty(true);
  };

  const updateChoiceValue = (id, value) => {
    setDetail((d) => ({ ...d, choices: d.choices.map((c) => (c.id === id ? { ...c, value } : c)) }));
    setDirty(true);
  };

  const addChoice = () => {
    setDetail((d) => {
      const existingLabels = new Set(d.choices.map((c) => c.label));
      let n = 1;
      while (existingLabels.has(`Label ${n}`)) n++;
      return { ...d, choices: [...d.choices, { id: crypto.randomUUID(), label: `Label ${n}`, value: 0.5 }] };
    });
    setDirty(true);
  };

  const removeChoice = (id) => {
    setDetail((d) => ({ ...d, choices: d.choices.filter((c) => c.id !== id) }));
    setDirty(true);
  };

  const handleSave = async () => {
    const { map: choice_scores, error: choicesError } = choicesToMap(detail.choices);
    if (choicesError) {
      setError(choicesError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: detail.name,
        description: detail.description || null,
        prompt_template: detail.prompt_template,
        choice_scores,
        pass_threshold: Number(detail.pass_threshold),
      };
      const saved = detail.id ? await updateScorer(detail.id, payload) : await createScorer(payload);
      currentIdRef.current = saved.id;
      setSelectedId(saved.id);
      setDetail({ ...saved, choices: choiceScoresToChoices(saved.choice_scores) });
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
    if (!window.confirm(`Delete scorer "${detail.name}"? This can't be undone.`)) return;
    await deleteScorer(detail.id);
    currentIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDirty(false);
    await refreshList();
  };

  if (loading) {
    return <ScorersSkeleton />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Scorers</h1>
        <button
          onClick={handleNew}
          className="px-4 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] transition-colors"
        >
          + New Scorer
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Custom LLM-judge rubrics — select one or more in Evaluation to score answers beyond the built-in
        faithfulness/relevance judge.
      </p>

      {error && <div className="text-red-400 mb-4">{error}</div>}

      <div className="flex gap-4" style={{ minHeight: 420 }}>
        <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-2 overflow-y-auto">
          {scorers.map((s) => (
            <button
              key={s.id}
              onClick={() => selectScorer(s.id)}
              className={`w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors ${
                s.id === selectedId ? "bg-[var(--brand-primary)]" : "hover:bg-white/5"
              }`}
            >
              <div className={`text-sm truncate ${s.id === selectedId ? "text-white" : "text-[var(--text-primary)]"}`}>
                {s.name}
              </div>
              <div className={`text-xs mt-0.5 ${s.id === selectedId ? "text-white/70" : "text-[var(--text-muted)]"}`}>
                {Object.keys(s.choice_scores).length} choices · {formatTimestamp(s.updated_at)}
              </div>
            </button>
          ))}
          {scorers.length === 0 && (
            <div className="text-sm text-[var(--text-muted)] p-3">No scorers yet. Create one to get started.</div>
          )}
        </div>

        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5 overflow-y-auto">
          {!detail ? (
            <div className="text-[var(--text-muted)]">
              {detailLoading ? "Loading…" : "Select a scorer to edit it."}
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between mb-4 gap-4">
                <div className="flex-1">
                  <input
                    value={detail.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="Scorer name"
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
                    disabled={saving || !detail.name.trim() || detail.choices.length === 0}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              <div className="text-sm font-medium text-[var(--text-primary)] mb-2">Judge Prompt</div>
              <textarea
                value={detail.prompt_template}
                onChange={(e) => updateField("prompt_template", e.target.value)}
                rows={6}
                placeholder="Use {{input}}, {{output}}, {{expected}} as placeholders"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--brand-primary)] mb-4"
              />

              <div className="text-sm font-medium text-[var(--text-primary)] mb-2">
                Choice Scores ({detail.choices.length})
              </div>
              <div className="flex flex-col gap-2 mb-3">
                {detail.choices.map((c) => (
                  <div key={c.id} className="flex gap-2 items-center">
                    <input
                      value={c.label}
                      onChange={(e) => updateChoiceLabel(c.id, e.target.value)}
                      placeholder="Label the judge must respond with"
                      className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                    />
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.1"
                      value={c.value}
                      onChange={(e) => updateChoiceValue(c.id, Number(e.target.value))}
                      className="w-24 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                    />
                    <button
                      onClick={() => removeChoice(c.id)}
                      disabled={detail.choices.length === 1}
                      className="px-2 py-2 text-[var(--text-muted)] hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove choice"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addChoice}
                className="px-3 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] text-sm hover:bg-white/10 transition-colors mb-4"
              >
                + Add choice
              </button>

              <div>
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                  Pass Threshold ({Number(detail.pass_threshold).toFixed(2)})
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={detail.pass_threshold}
                  onChange={(e) => updateField("pass_threshold", Number(e.target.value))}
                  className="w-full max-w-xs"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
