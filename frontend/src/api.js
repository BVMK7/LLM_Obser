// Thin wrapper around the FastAPI backend. Reads VITE_API_BASE (set in
// frontend/.env, see .env.example) so the same dashboard can point at either
// the local backend or a deployed one without a code change.
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8010";

// Every tenant-owned endpoint now requires an X-API-Key header. This ships
// with the same fixed dev key the projects/api_keys migration bakes in for
// the pre-existing "Default Project" (see create_projects_and_api_keys.sql)
// so the existing local dev flow keeps working with zero setup; switching
// the dropdown in Topbar to a different project just overwrites this.
const DEFAULT_API_KEY = "llmobs_dev_default_do_not_use_in_prod";
const STORAGE_KEY = "llmobs_active_api_key";

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_API_KEY;
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

function authHeaders() {
  return { "X-API-Key": getApiKey() };
}

export async function getTraces() {
  const res = await fetch(`${API_BASE}/traces`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load traces");
  return res.json();
}

export async function getTrace(id) {
  const res = await fetch(`${API_BASE}/traces/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load trace");
  return res.json();
}

export async function runPlayground(payload) {
  const res = await fetch(`${API_BASE}/playground/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Playground run failed");
  return res.json();
}

export async function runEvaluation(payload) {
  const res = await fetch(`${API_BASE}/evaluation/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Evaluation run failed");
  return res.json();
}

export async function runEvaluationOne(payload) {
  const res = await fetch(`${API_BASE}/evaluation/run_one`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
  const res = await fetch(`${API_BASE}/datasets`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load datasets");
  return res.json();
}

export async function getDataset(id) {
  const res = await fetch(`${API_BASE}/datasets/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load dataset");
  return res.json();
}

export async function createDataset(payload) {
  const res = await fetch(`${API_BASE}/datasets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to create dataset");
  return res.json();
}

export async function updateDataset(id, payload) {
  const res = await fetch(`${API_BASE}/datasets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to update dataset");
  return res.json();
}

export async function deleteDataset(id) {
  const res = await fetch(`${API_BASE}/datasets/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to delete dataset");
  return res.json();
}

export async function getPrompts() {
  const res = await fetch(`${API_BASE}/prompts`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load prompts");
  return res.json();
}

export async function getPrompt(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load prompt");
  return res.json();
}

export async function createPrompt(payload) {
  const res = await fetch(`${API_BASE}/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to create prompt");
  return res.json();
}

export async function updatePrompt(id, payload) {
  const res = await fetch(`${API_BASE}/prompts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to update prompt");
  return res.json();
}

export async function deletePrompt(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to delete prompt");
  return res.json();
}

export async function usePrompt(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}/use`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to record prompt usage");
  return res.json();
}

export async function getPromptVersions(id) {
  const res = await fetch(`${API_BASE}/prompts/${id}/versions`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load prompt versions");
  return res.json();
}

// Shared helper for the newer endpoints below — same fetch-wrapper idiom as
// every function above, just without repeating the method/headers/error text
// four times per resource.
async function request(path, { method = "GET", body, errorMessage } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json", ...authHeaders() } : authHeaders(),
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

// Projects — multi-tenancy. These two endpoints are intentionally
// unauthenticated (no admin login exists yet) so onboarding a new customer
// (or, in the frontend, switching the project-switcher dropdown) doesn't
// need a key first.
export const getProjects = () => request("/projects", { errorMessage: "Failed to load projects" });
export const createProject = (payload) => request("/projects", { method: "POST", body: payload, errorMessage: "Failed to create project" });
export const createApiKey = (projectId) =>
  request(`/projects/${projectId}/api-keys`, { method: "POST", body: {}, errorMessage: "Failed to issue API key" });
export const deleteProject = (id) => request(`/projects/${id}`, { method: "DELETE", errorMessage: "Failed to delete project" });
