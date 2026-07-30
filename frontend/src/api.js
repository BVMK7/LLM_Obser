// Thin wrapper around the FastAPI backend.
const API_BASE = "http://localhost:8010";

export async function getTraces() {
  const res = await fetch(`${API_BASE}/traces`);
  if (!res.ok) throw new Error("Failed to load traces");
  return res.json();
}

export async function getTrace(id) {
  const res = await fetch(`${API_BASE}/traces/${id}`);
  if (!res.ok) throw new Error("Failed to load trace");
  return res.json();
}

export async function runPlayground(payload) {
  const res = await fetch(`${API_BASE}/playground/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Playground run failed");
  return res.json();
}

export async function runEvaluation(payload) {
  const res = await fetch(`${API_BASE}/evaluation/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Evaluation run failed");
  return res.json();
}

export async function runEvaluationOne(payload) {
  const res = await fetch(`${API_BASE}/evaluation/run_one`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Evaluation case failed");
  return res.json();
}

export async function getProviderStatus() {
  const res = await fetch(`${API_BASE}/providers/status`);
  if (!res.ok) throw new Error("Failed to load provider status");
  return res.json();
}

export async function getModelCatalog() {
  const res = await fetch(`${API_BASE}/models/catalog`);
  if (!res.ok) throw new Error("Failed to load model catalog");
  return res.json();
}

export async function getDatasets() {
  const res = await fetch(`${API_BASE}/datasets`);
  if (!res.ok) throw new Error("Failed to load datasets");
  return res.json();
}

export async function getDataset(id) {
  const res = await fetch(`${API_BASE}/datasets/${id}`);
  if (!res.ok) throw new Error("Failed to load dataset");
  return res.json();
}

export async function createDataset(payload) {
  const res = await fetch(`${API_BASE}/datasets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to create dataset");
  return res.json();
}

export async function updateDataset(id, payload) {
  const res = await fetch(`${API_BASE}/datasets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to update dataset");
  return res.json();
}

export async function deleteDataset(id) {
  const res = await fetch(`${API_BASE}/datasets/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete dataset");
  return res.json();
}

export async function getPrompts() {
  const res = await fetch(`${API_BASE}/prompts`);
  if (!res.ok) throw new Error("Failed to load prompts");
  return res.json();
}

export async function getPrompt(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}`);
  if (!res.ok) throw new Error("Failed to load prompt");
  return res.json();
}

export async function createPrompt(payload) {
  const res = await fetch(`${API_BASE}/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to create prompt");
  return res.json();
}

export async function updatePrompt(id, payload) {
  const res = await fetch(`${API_BASE}/prompts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to update prompt");
  return res.json();
}

export async function deletePrompt(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete prompt");
  return res.json();
}

export async function usePrompt(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}/use`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to record prompt usage");
  return res.json();
}

export async function getPromptVersions(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}/versions`);
  if (!res.ok) throw new Error("Failed to load prompt versions");
  return res.json();
}

// Shared helper for the newer endpoints below — same fetch-wrapper idiom as
// every function above, just without repeating the method/headers/error text
// four times per resource.
async function request(path, { method = "GET", body, errorMessage } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(errorMessage || `Request to ${path} failed`);
  return res.json();
}

export async function createScore(payload) {
  return request("/scores", { method: "POST", body: payload, errorMessage: "Failed to save score" });
}

export async function flagTrace(id, payload) {
  return request(`/traces/${id}/flag`, { method: "PATCH", body: payload, errorMessage: "Failed to update review flag" });
}

export const getScorers = () => request("/scorers", { errorMessage: "Failed to load scorers" });
export const getScorer = (id) => request(`/scorers/${id}`, { errorMessage: "Failed to load scorer" });
export const createScorer = (payload) => request("/scorers", { method: "POST", body: payload, errorMessage: "Failed to create scorer" });
export const updateScorer = (id, payload) => request(`/scorers/${id}`, { method: "PUT", body: payload, errorMessage: "Failed to update scorer" });
export const deleteScorer = (id) => request(`/scorers/${id}`, { method: "DELETE", errorMessage: "Failed to delete scorer" });

export const getExperiments = () => request("/experiments", { errorMessage: "Failed to load experiments" });
export const getExperiment = (id) => request(`/experiments/${id}`, { errorMessage: "Failed to load experiment" });
export const createExperiment = (payload) => request("/experiments", { method: "POST", body: payload, errorMessage: "Failed to save experiment" });
export const deleteExperiment = (id) => request(`/experiments/${id}`, { method: "DELETE", errorMessage: "Failed to delete experiment" });
export const analyzeExperiment = (id, payload = {}) =>
  request(`/experiments/${id}/analyze`, { method: "POST", body: payload, errorMessage: "Analysis failed" });

export const getAlertRules = () => request("/alert-rules", { errorMessage: "Failed to load alert rules" });
export const createAlertRule = (payload) => request("/alert-rules", { method: "POST", body: payload, errorMessage: "Failed to create alert rule" });
export const updateAlertRule = (id, payload) => request(`/alert-rules/${id}`, { method: "PUT", body: payload, errorMessage: "Failed to update alert rule" });
export const deleteAlertRule = (id) => request(`/alert-rules/${id}`, { method: "DELETE", errorMessage: "Failed to delete alert rule" });
export const getAlertsStatus = () => request("/alerts/status", { errorMessage: "Failed to load alert status" });
