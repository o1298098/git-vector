const TOKEN_KEY = "gv_admin_ui_token";

type ApiErrorPayload = {
  code?: string;
  message?: string;
  hint?: string;
  retryable?: boolean;
  request_id?: string;
  detail?: unknown;
};

export class ApiError extends Error {
  code: string;
  hint: string;
  retryable: boolean;
  requestId: string;
  status: number;

  constructor(message: string, options: { status: number; code?: string; hint?: string; retryable?: boolean; requestId?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code || "HTTP_ERROR";
    this.hint = options.hint || "";
    this.retryable = Boolean(options.retryable);
    this.requestId = options.requestId || "";
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let payload: ApiErrorPayload | null = null;
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      payload = (await res.json()) as ApiErrorPayload;
      if (payload?.message) detail = payload.message;
      else if (payload?.detail) detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
    } catch {
      /* ignore */
    }
    const suffix = payload?.request_id ? ` (request_id=${payload.request_id})` : "";
    throw new ApiError(`${detail}${suffix}`, {
      status: res.status,
      code: payload?.code,
      hint: payload?.hint,
      retryable: payload?.retryable,
      requestId: payload?.request_id,
    });
  }
  return res.json() as Promise<T>;
}
