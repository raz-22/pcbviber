import type { PartSearchResult, PartAvailabilitySummary } from "@altium-mcp/shared";

/**
 * Typed error so UI components can pattern-match on the server's
 * error code (e.g. distinguish `email_taken` from `invalid_credentials`)
 * without parsing strings.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: unknown;

  constructor(status: number, code: string | null, detail: unknown, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = "ApiError";
  }
}

interface ApiOpts {
  method?: "GET" | "POST";
  body?: unknown;
}

/**
 * Single fetch wrapper used for every backend call. `credentials: "include"`
 * is essential — otherwise the browser won't send the session cookie on
 * cross-origin requests during dev (Vite :5173 → Fastify :3000).
 */
async function call<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? "GET",
    credentials: "include",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  };

  const res = await fetch(path, init);

  if (res.status === 204) {
    return undefined as T;
  }

  const ct = res.headers.get("content-type") ?? "";
  let parsed: unknown = null;
  if (ct.includes("application/json")) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
  } else {
    try {
      const text = await res.text();
      parsed = text || null;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const obj = (parsed && typeof parsed === "object" ? parsed : {}) as {
      error?: string;
      detail?: unknown;
    };
    const code = typeof obj.error === "string" ? obj.error : null;
    const message =
      code ?? `${res.status} ${res.statusText}`.trim() ?? "request failed";
    throw new ApiError(res.status, code, obj.detail, message);
  }

  return parsed as T;
}

// ── Types returned by /api/auth/* ────────────────────────────────────

export interface AuthMe {
  user: {
    id: string;
    email: string;
    emailVerifiedAt: string | null;
    createdAt: string;
  };
  orgs: Array<{
    id: string;
    slug: string;
    name: string;
    role: string;
  }>;
}

export interface SignupResponse {
  user: AuthMe["user"];
  org: { id: string; slug: string; name: string };
}

export interface LoginResponse extends AuthMe {}

export const api = {
  // ─── Auth ──────────────────────────────────────────────────────────
  signup: (input: {
    email: string;
    password: string;
    name?: string;
    orgName?: string;
  }) =>
    call<SignupResponse>("/api/auth/signup", { method: "POST", body: input }),

  login: (input: { email: string; password: string }) =>
    call<LoginResponse>("/api/auth/login", { method: "POST", body: input }),

  logout: () => call<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  me: () => call<AuthMe>("/api/auth/me"),

  // ─── Parts (existing) ──────────────────────────────────────────────
  searchParts: (query: string, limit = 10) =>
    call<PartSearchResult[]>(
      `/api/parts/search?query=${encodeURIComponent(query)}&limit=${limit}`
    ),

  checkAvailability: (mpn: string) =>
    call<PartAvailabilitySummary | { notFound: true; mpn: string }>(
      `/api/parts/availability?mpn=${encodeURIComponent(mpn)}`
    ),

  health: () => call<{ ok: boolean; name: string; version: string }>("/api/health"),
};
