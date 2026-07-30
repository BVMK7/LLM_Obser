import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProviderStatus, runPlayground, getModelCatalog, getPrompts, createPrompt, usePrompt, createScore } from "../api";
import Slider from "../components/Slider";
import CopyButton from "../components/CopyButton";
import { formatCost, formatTokens } from "../utils";

const PROVIDERS = ["gemini", "groq", "openrouter"];

const SYSTEM_PROMPT_PRESETS = [
  {
    key: "general",
    label: "General Assistant",
    prompt: "You are a helpful, knowledgeable AI assistant. Answer clearly and concisely.",
  },
  {
    key: "technical",
    label: "Technical / Support Assistant",
    prompt:
      "You are a technical assistant that helps engineers debug issues, explain code, and answer questions accurately and concisely.",
  },
  {
    key: "branded",
    label: "Branded Support Assistant",
    prompt: "You are a helpful AI assistant for Tao Digital. Be professional, concise, and accurate.",
  },
  { key: "empty", label: "Empty (no persona)", prompt: "" },
];

function formatMs(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export default function Playground() {
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(1.0);
  const [preset, setPreset] = useState(SYSTEM_PROMPT_PRESETS[0].key);
  const [systemPrompt, setSystemPrompt] = useState(SYSTEM_PROMPT_PRESETS[0].prompt);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [providerStatus, setProviderStatus] = useState(null);
  const [modelCatalog, setModelCatalog] = useState(null);
  const [model, setModel] = useState(null);
  const [libraryPrompts, setLibraryPrompts] = useState([]);

  const refreshLibraryPrompts = () => getPrompts().then(setLibraryPrompts).catch(() => {});

  useEffect(() => {
    getProviderStatus()
      .then(setProviderStatus)
      .catch(() => {}); // best-effort — a missing status check shouldn't block the page
    getModelCatalog()
      .then((catalog) => {
        setModelCatalog(catalog);
        setModel(catalog[provider]?.default ?? null);
      })
      .catch(() => {}); // best-effort — falls back to the backend's own default if this fails
    refreshLibraryPrompts(); // best-effort — a missing library list just leaves the built-ins
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecting a preset overwrites the textarea; a library pick also bumps
  // its usage_count (fire-and-forget — a failed count bump shouldn't block
  // using the prompt).
  const handlePresetChange = (value) => {
    setPreset(value);
    const builtin = SYSTEM_PROMPT_PRESETS.find((p) => p.key === value);
    if (builtin) {
      setSystemPrompt(builtin.prompt);
      return;
    }
    const saved = libraryPrompts.find((p) => p.id === value);
    if (saved) {
      setSystemPrompt(saved.content);
      usePrompt(saved.id).catch(() => {});
    }
  };

  const handleSavePromptToLibrary = async () => {
    if (!systemPrompt.trim()) return;
    const name = window.prompt("Save this system prompt to the library — name it:");
    if (!name || !name.trim()) return;
    try {
      await createPrompt({ name: name.trim(), category: "system", content: systemPrompt });
      await refreshLibraryPrompts();
    } catch {
      // best-effort — the prompt is still usable locally even if saving fails
    }
  };

  // Reset to the new provider's default model whenever the provider changes,
  // rather than carrying over a model string that may not belong to it.
  const handleProviderChange = (nextProvider) => {
    setProvider(nextProvider);
    setModel(modelCatalog?.[nextProvider]?.default ?? null);
  };

  const totalLatencyMs = messages.reduce((sum, m) => sum + (m.latency_ms || 0), 0);
  const totalCost = messages.reduce((sum, m) => sum + (m.cost || 0), 0);
  const inputTokens = messages.reduce((sum, m) => sum + (m.input_tokens || 0), 0);
  const outputTokens = messages.reduce((sum, m) => sum + (m.output_tokens || 0), 0);
  const lastTrace = [...messages].reverse().find((m) => m.trace)?.trace;

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMessage = { role: "user", content: input };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const data = await runPlayground({
        provider,
        messages: nextMessages.map(({ role, content }) => ({ role, content })),
        system_prompt: systemPrompt || undefined,
        model,
        temperature,
        top_p: topP,
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          latency_ms: data.latency_ms,
          input_tokens: data.input_tokens,
          output_tokens: data.output_tokens,
          cost: data.cost,
          trace: data.trace,
        },
      ]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setError(null);
  };

  // Records a real human 👍/👎 against the real trace this response created
  // (see main.py's create_score) — the same Score table score_trace.py
  // writes to, just scored by a human instead of an LLM judge.
  const handleFeedback = async (index, value) => {
    const message = messages[index];
    if (!message.trace) return;
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, feedback: value } : m)));
    try {
      await createScore({ trace_id: message.trace.id, score_name: "user_feedback", score_value: value });
    } catch {
      // best-effort — the UI already reflects the click; a failed write just
      // means it won't show up on the trace later.
    }
  };

  const assistantTurns = messages.filter((m) => m.role === "assistant");

  return (
    <div className="flex gap-4 h-full">
      {/* Left: configuration */}
      <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 overflow-y-auto">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-3">Configuration</div>

        <label className="block text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Provider</label>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] mb-4 focus:outline-none focus:border-[var(--brand-primary)]"
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        {modelCatalog?.[provider] && (
          <>
            <label className="block text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Model</label>
            <select
              value={model ?? modelCatalog[provider].default}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] mb-4 focus:outline-none focus:border-[var(--brand-primary)]"
            >
              {modelCatalog[provider].models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </>
        )}

        {providerStatus && providerStatus[provider] === false && (
          <div className="text-xs text-[var(--brand-danger)] mb-4">
            ⚠ {provider} isn't configured —{" "}
            <Link to="/settings" className="underline">
              check Settings
            </Link>
            .
          </div>
        )}

        <Slider label="Temperature" value={temperature} onChange={setTemperature} min={0} max={2} step={0.1} />
        <Slider label="Top-P" value={topP} onChange={setTopP} min={0} max={1} step={0.05} />

        <label className="block text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">System Prompt</label>
        <select
          value={preset}
          onChange={(e) => handlePresetChange(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] mb-2 focus:outline-none focus:border-[var(--brand-primary)]"
        >
          <optgroup label="Built-in">
            {SYSTEM_PROMPT_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </optgroup>
          {libraryPrompts.length > 0 && (
            <optgroup label="My Prompts">
              {libraryPrompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          placeholder="Optional — describe how the assistant should behave."
          className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] mb-2 focus:outline-none focus:border-[var(--brand-primary)] resize-none"
        />
        <button
          onClick={handleSavePromptToLibrary}
          disabled={!systemPrompt.trim()}
          className="w-full px-3 py-1.5 rounded-lg bg-white/5 text-[var(--text-secondary)] text-xs hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors mb-4"
        >
          Save to Prompt Library
        </button>

        <button
          onClick={handleReset}
          disabled={messages.length === 0}
          className="w-full px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Reset Conversation
        </button>
      </div>

      {/* Middle: chat */}
      <div className="flex-1 flex flex-col bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {messages.length === 0 && (
            <div className="text-sm text-[var(--text-muted)]">
              Send a prompt to start a conversation with {provider}.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-xl px-4 py-3 text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-[var(--brand-primary)] text-white"
                    : "bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
                }`}
              >
                {m.role === "assistant" && (
                  <div className="text-[10px] uppercase tracking-wide text-[var(--brand-success)] mb-1">
                    Assistant Response
                  </div>
                )}
                {m.content}
                {m.role === "assistant" && (
                  <div className="text-[10px] text-[var(--text-muted)] mt-2 flex items-center justify-between gap-2">
                    <span>
                      DUR: {formatMs(m.latency_ms)} · TOK: {formatTokens((m.input_tokens || 0) + (m.output_tokens || 0))}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleFeedback(i, 1)}
                        title="Good response"
                        className={`transition-opacity ${m.feedback === 1 ? "opacity-100" : "opacity-40 hover:opacity-70"}`}
                      >
                        👍
                      </button>
                      <button
                        onClick={() => handleFeedback(i, 0)}
                        title="Bad response"
                        className={`transition-opacity ${m.feedback === 0 ? "opacity-100" : "opacity-40 hover:opacity-70"}`}
                      >
                        👎
                      </button>
                      <CopyButton text={m.content} />
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && <div className="text-sm text-[var(--text-muted)]">Waiting for {provider}…</div>}
          {error && (
            <div className="text-sm text-red-400">
              Couldn't reach the API — is it running at http://localhost:8010? ({error})
            </div>
          )}
        </div>

        <div className="p-3 border-t border-[var(--border-subtle)] flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Enter prompt to run trace..."
            className="flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ➤
          </button>
        </div>
      </div>

      {/* Right: trace insights */}
      <div className="w-72 shrink-0 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 overflow-y-auto">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-3">Trace Insights</div>

        <div className="mb-4">
          <div className="text-xs text-[var(--text-muted)] mb-1">Total Latency</div>
          <div className="text-xl font-semibold text-[var(--brand-success)]">{formatMs(totalLatencyMs)}</div>
        </div>
        <div className="mb-4">
          <div className="text-xs text-[var(--text-muted)] mb-1">Estimated Cost</div>
          <div className="text-xl font-semibold text-[var(--brand-warning)]">{formatCost(totalCost)}</div>
        </div>
        <div className="mb-4">
          <div className="text-xs text-[var(--text-muted)] mb-1">Token Usage</div>
          <div className="text-xl font-semibold text-[var(--text-primary)]">
            {formatTokens(inputTokens + outputTokens)}
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            In: {formatTokens(inputTokens)} · Out: {formatTokens(outputTokens)}
          </div>
        </div>

        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Conversation Turns</div>
        <div className="flex flex-col gap-2 mb-4">
          {assistantTurns.length === 0 && (
            <div className="text-xs text-[var(--text-muted)]">No turns yet.</div>
          )}
          {assistantTurns.map((m, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-[var(--text-secondary)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-success)] inline-block" />
                Response #{i + 1}
              </span>
              <span className="text-[var(--text-muted)]">{formatMs(m.latency_ms)}</span>
            </div>
          ))}
        </div>

        {lastTrace && (
          <Link to="/traces" className="text-xs text-[var(--brand-primary)] hover:underline">
            View in Traces →
          </Link>
        )}
      </div>
    </div>
  );
}
