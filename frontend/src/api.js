// Thin wrapper around the FastAPI backend. Reads VITE_API_BASE (set in
// frontend/.env, see .env.example) so the same dashboard can point at either
// the local backend or a deployed one without a code change.
export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8010";

// Every tenant-owned endpoint requires an X-API-Key header. No hardcoded
// fallback key here on purpose — ProjectSwitcher.jsx is responsible for
// setting a real key for a real project the logged-in user belongs to
// (minting one via POST /projects/{id}/api-keys if none is on file yet).
// If nothing's set, requests correctly 401 instead of silently reading
// whichever project a hardcoded key happened to belong to.
const STORAGE_KEY = "llmobs_active_api_key";

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || "";
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

function authHeaders() {
  return { "X-API-Key": getApiKey() };
}

// A second, separate credential — the logged-in user's session, used only
// for project MANAGEMENT calls (projects/members/invites/api-keys/billing).
// Never merged with the X-API-Key above: that one authenticates the SDK's
// data plane and must keep working with no login at all.
const USER_TOKEN_KEY = "llmobs_user_session_token";

export function getUserToken() {
  return localStorage.getItem(USER_TOKEN_KEY) || "";
}

export function setUserToken(token) {
  if (token) localStorage.setItem(USER_TOKEN_KEY, token);
  else localStorage.removeItem(USER_TOKEN_KEY);
}

function userAuthHeaders() {
  const token = getUserToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
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
// four times per resource. `auth: "user"` swaps in the Bearer session header
// instead of X-API-Key, for the project-management endpoints.
async function request(path, { method = "GET", body, errorMessage, auth = "apiKey" } = {}) {
  const authHeadersFn = auth === "user" ? userAuthHeaders : authHeaders;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json", ...authHeadersFn() } : authHeadersFn(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(errorMessage || `Request to ${path} failed`);
  if (res.status === 204) return null;
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

// Auth — real user accounts. Separate credential from the X-API-Key data
// plane above (see userAuthHeaders); gates project management only.
export const signup = (payload) => request("/auth/signup", { method: "POST", body: payload, errorMessage: "Signup failed" });
export const login = (payload) => request("/auth/login", { method: "POST", body: payload, errorMessage: "Invalid email or password" });
export const getMe = () => request("/auth/me", { auth: "user", errorMessage: "Not logged in" });
export const logout = () => request("/auth/logout", { method: "POST", auth: "user", errorMessage: "Logout failed" });

// Projects — multi-tenancy. Listing/creating/deleting a project, and
// everything under project management, requires the logged-in user's
// session and is scoped to projects they're a member of.
export const getProjects = () => request("/projects", { auth: "user", errorMessage: "Failed to load projects" });
export const createProject = (payload) => request("/projects", { method: "POST", body: payload, auth: "user", errorMessage: "Failed to create project" });
// `payload` is the full ProjectUpdate body (name + optional kill-switch
// fields) — the backend uses exclude_unset semantics, so omitted fields
// are left untouched rather than cleared.
export const updateProject = (id, payload) => request(`/projects/${id}`, { method: "PATCH", body: payload, auth: "user", errorMessage: "Failed to update project" });
export const deleteProject = (id) => request(`/projects/${id}`, { method: "DELETE", auth: "user", errorMessage: "Failed to delete project" });

export const createApiKey = (projectId) =>
  request(`/projects/${projectId}/api-keys`, { method: "POST", body: {}, auth: "user", errorMessage: "Failed to issue API key" });
export const getApiKeys = (projectId) => request(`/projects/${projectId}/api-keys`, { auth: "user", errorMessage: "Failed to load API keys" });
export const revokeApiKey = (projectId, keyId) =>
  request(`/projects/${projectId}/api-keys/${keyId}`, { method: "DELETE", auth: "user", errorMessage: "Failed to revoke API key" });

// Team members & invites — v1 invites are a copy/paste link (shown once).
export const getMembers = (projectId) => request(`/projects/${projectId}/members`, { auth: "user", errorMessage: "Failed to load members" });
export const updateMemberRole = (projectId, userId, role) =>
  request(`/projects/${projectId}/members/${userId}`, { method: "PATCH", body: { role }, auth: "user", errorMessage: "Failed to update role" });
export const removeMember = (projectId, userId) =>
  request(`/projects/${projectId}/members/${userId}`, { method: "DELETE", auth: "user", errorMessage: "Failed to remove member" });
export const getInvites = (projectId) => request(`/projects/${projectId}/invites`, { auth: "user", errorMessage: "Failed to load invites" });
export const createInvite = (projectId, payload) =>
  request(`/projects/${projectId}/invites`, { method: "POST", body: payload, auth: "user", errorMessage: "Failed to create invite" });
export const revokeInvite = (projectId, inviteId) =>
  request(`/projects/${projectId}/invites/${inviteId}`, { method: "DELETE", auth: "user", errorMessage: "Failed to revoke invite" });
export const acceptInvite = (token) =>
  request("/invites/accept", { method: "POST", body: { token }, auth: "user", errorMessage: "Failed to accept invite" });
