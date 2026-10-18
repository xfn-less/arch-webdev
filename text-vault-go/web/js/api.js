export class APIError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.code = code;
  }
}

export class UnauthorizedError extends APIError {
  constructor() { super("unauthorized", 401, "unauthorized"); this.name = "UnauthorizedError"; }
}

export class ConflictError extends APIError {
  constructor() { super("conflict", 409, "conflict"); this.name = "ConflictError"; }
}

export function createAPI(fetchFn = fetch) {
  let csrfToken = "";

  async function request(path, {method = "GET", body, csrf = false} = {}) {
    const headers = {Accept: "application/json"};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = "request_failed";
      try { code = (await response.json()).error ?? code; } catch {}
      if (response.status === 401) throw new UnauthorizedError();
      if (response.status === 409) throw new ConflictError();
      throw new APIError(code, response.status, code);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  return {
    csrfToken: () => csrfToken,
    setCSRFToken(value) {
      if (typeof value !== "string") throw new TypeError("invalid csrf token");
      csrfToken = value;
    },
    async login(credential) {
      const result = await request("/api/login", {method: "POST", body: {credential}});
      csrfToken = result.csrfToken;
      return result;
    },
    async setup(header, credential) {
      const result = await request("/api/setup", {method: "POST", body: {header, credential}});
      csrfToken = result.csrfToken;
      return result;
    },
    logout: () => request("/api/logout", {method: "POST", csrf: true}),
    async rekey(header, credential) {
      const result = await request("/api/rekey", {method: "POST", body: {header, credential}, csrf: true});
      csrfToken = result.csrfToken;
      return result;
    },
    vault: () => request("/api/vault"),
    snapshot: () => request("/api/snapshot"),
    changes: after => request(`/api/changes?after=${encodeURIComponent(String(after))}`),
    commit: value => request("/api/commit", {method: "POST", body: value, csrf: true}),
  };
}
