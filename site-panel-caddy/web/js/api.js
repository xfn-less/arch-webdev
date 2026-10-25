let csrf = "";
export function setCSRF(value) {
  csrf = value || "";
}
async function request(
  path,
  { method = "GET", body, raw = false, text = false, signal } = {},
) {
  const headers = {};
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    signal,
    credentials: "same-origin",
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return text ? response.text() : response.json();
}
export const api = {
  session: () => request("/session"),
  login: (password, setup) =>
    request(setup ? "/setup" : "/login", {
      method: "POST",
      body: { password },
    }),
  logout: () => request("/logout", { method: "POST" }),
  nodes: () => request("/nodes"),
  probe: (value) => request("/nodes/probe", { method: "POST", body: value }),
  addNode: (value) => request("/nodes", { method: "POST", body: value }),
  updateNode: (id, value) =>
    request(`/nodes/${id}`, { method: "PUT", body: value }),
  updateNodeFingerprint: (id, fingerprint) =>
    request(`/nodes/${id}/fingerprint`, {
      method: "PUT",
      body: { fingerprint },
    }),
  install: (id) => request(`/nodes/${id}/install`, { method: "POST" }),
  deleteNode: (id) => request(`/nodes/${id}`, { method: "DELETE" }),
  nodeStatuses: () => request("/nodes/statuses"),
  status: (id) => request(`/nodes/${id}/status`),
  nodePassword: (id) => request(`/nodes/${id}/password`),
  sites: () => request("/sites"),
  addSite: (value) => request("/sites", { method: "POST", body: value }),
  updateSite: (id, value) =>
    request(`/sites/${id}`, { method: "PUT", body: value }),
  saveVars: (id, vars) =>
    request(`/sites/${id}/vars`, { method: "PUT", body: { vars } }),
  requestSSL: (id, value) =>
    request(`/sites/${id}/ssl`, { method: "POST", body: value }),
  syncSSL: (id) => request(`/sites/${id}/ssl/sync`, { method: "POST" }),
  config: (id) => request(`/sites/${id}/config`),
  saveConfig: (id, config) =>
    request(`/sites/${id}/config`, {
      method: "PUT",
      body: { config },
    }),
  resetConfig: (id) => request(`/sites/${id}/config`, { method: "DELETE" }),
  files: (id) => request(`/sites/${id}/files`),
  read: (id, path) =>
    request(`/sites/${id}/file?path=${encodeURIComponent(path)}`, {
      text: true,
    }),
  write: (id, path, body) =>
    request(`/sites/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "POST",
      body,
      raw: true,
    }),
  deleteFile: (id, path) =>
    request(`/sites/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  mkdir: (id, path) =>
    request(`/sites/${id}/mkdir`, { method: "POST", body: { path } }),
  renameFile: (id, from, to) =>
    request(`/sites/${id}/rename`, { method: "POST", body: { from, to } }),
  downloadURL: (id, path) =>
    `/api/sites/${id}/download?path=${encodeURIComponent(path)}`,
  unzip: (id, body, dest = "", filename = "") =>
    request(
      `/sites/${id}/unzip?dest=${encodeURIComponent(dest)}&filename=${encodeURIComponent(filename || body?.name || "")}`,
      {
        method: "POST",
        body,
        raw: true,
      },
    ),
  dns: (id) => request(`/sites/${id}/dns`),
  inspect: (id) => request(`/sites/${id}/inspect`),
  deployPreview: (id) => request(`/sites/${id}/deploy-preview`),
  deploy: (id, value={}) => request(`/sites/${id}/deploy`, { method: "POST", body: value }),
  bindSite: (id, node_id) => request(`/sites/${id}/bind`, { method: "PUT", body: { node_id } }),
  copySite: (id, value) => request(`/sites/${id}/copy`, { method: "POST", body: value }),
  disableSite: (id) => request(`/sites/${id}/disable`, { method: "POST" }),
  enableSite: (id) => request(`/sites/${id}/enable`, { method: "POST" }),
  deleteSite: (id, value={}) => request(`/sites/${id}`, { method: "DELETE", body: value }),
  tasks: (nodeId) => request(`/tasks?node_id=${encodeURIComponent(nodeId)}`),
  taskLogs: (id, nodeId, signal) =>
    request(`/tasks/${id}/logs?node_id=${encodeURIComponent(nodeId)}`, {
      signal,
    }),
  refreshTask: (id, nodeId) =>
    request(`/tasks/${id}/refresh?node_id=${encodeURIComponent(nodeId)}`, {
      method: "POST",
    }),
  dismissTask: (id, nodeId) =>
    request(`/tasks/${id}/dismiss?node_id=${encodeURIComponent(nodeId)}`, {
      method: "POST",
    }),
  dismissNodeAttention: (nodeId) =>
    request(`/nodes/${nodeId}/dismiss-attention`, { method: "POST" }),
  telegram: () => request("/telegram"),
  saveTelegram: (value) =>
    request("/telegram", { method: "PUT", body: value }),
  pushTelegramOverview: () =>
    request("/telegram/overview", { method: "POST", body: {} }),
};
