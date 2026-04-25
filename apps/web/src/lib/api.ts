import type {
  PartSearchResult,
  PartAvailabilitySummary,
  AltiumComponent,
  AltiumWorkspace,
  AltiumProject,
} from "@altium-mcp/shared";

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
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

// ── CSRF token cache + bootstrap ────────────────────────────────────
//
// State-change requests (POST/PATCH/DELETE) carry an `x-csrf-token`
// header. The token comes from `GET /api/csrf` which sets a signed
// cookie + returns the matching token in the response body. We cache
// the token in module memory; on first state-change OR on a 403
// `csrf_invalid` response, we refetch.

let cachedCsrfToken: string | null = null;
/** Reset for tests + sign-out flows so the next call refetches. */
export function __resetCsrfTokenCacheForTests(): void {
  cachedCsrfToken = null;
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch("/api/csrf", { credentials: "include" });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      "csrf_bootstrap_failed",
      null,
      "Could not initialize CSRF token"
    );
  }
  // Defensive: a malformed body shouldn't surface as an
  // unhandled SyntaxError — wrap it so the caller's catch sees
  // the same ApiError shape every other fetch failure produces.
  let data: { csrfToken?: string };
  try {
    data = (await res.json()) as { csrfToken?: string };
  } catch {
    throw new ApiError(
      res.status,
      "csrf_bootstrap_failed",
      null,
      "CSRF endpoint returned non-JSON body"
    );
  }
  if (typeof data.csrfToken !== "string" || data.csrfToken.length === 0) {
    throw new ApiError(
      res.status,
      "csrf_bootstrap_failed",
      null,
      "CSRF endpoint returned no token"
    );
  }
  cachedCsrfToken = data.csrfToken;
  return data.csrfToken;
}

function isStateChange(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

/**
 * Single fetch wrapper used for every backend call. `credentials: "include"`
 * is essential — otherwise the browser won't send the session cookie on
 * cross-origin requests during dev (Vite :5173 → Fastify :3000).
 *
 * State-change requests auto-inject the `x-csrf-token` header. On the
 * first 403 with `error: "csrf_invalid"` we refetch the token and
 * retry once (handles cookie expiry / token rotation). Subsequent
 * 403s propagate as ApiError so the caller can show an error.
 */
async function call<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const method = opts.method ?? "GET";
  return await callWithCsrfRetry<T>(path, method, opts, /* retried */ false);
}

async function callWithCsrfRetry<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  opts: ApiOpts,
  retried: boolean
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (isStateChange(method)) {
    const token = cachedCsrfToken ?? (await fetchCsrfToken());
    headers["x-csrf-token"] = token;
  }

  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

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
    // CSRF token expired / rotated — refetch once and retry.
    // Subsequent failures propagate as ApiError so the caller can
    // surface a stable error.
    if (
      code === "csrf_invalid" &&
      isStateChange(method) &&
      !retried
    ) {
      cachedCsrfToken = null;
      return await callWithCsrfRetry<T>(path, method, opts, true);
    }
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
    /** "free" | "trialing" | "active" | "past_due" | "suspended" | "canceled" */
    billingStatus: string;
    /** ISO-8601 string while trialing; null otherwise. */
    trialEndsAt: string | null;
  }>;
}

export interface SignupResponse {
  user: AuthMe["user"];
  org: {
    id: string;
    slug: string;
    name: string;
    billingStatus: string;
    trialEndsAt: string | null;
  };
}

export interface LoginResponse extends AuthMe {}

// ── Types returned by /api/orgs/:orgId/workspaces/* ───────────────────

/**
 * Workspace shape returned by the server. Mirrors `serializeWorkspace`
 * in apps/server/src/workspaces/routes.ts — never includes ciphertext,
 * only metadata + booleans for "is configured" UI hints.
 */
export interface Workspace {
  id: string;
  orgId: string;
  altiumWorkspaceUrl: string | null;
  hasNexarCredentials: boolean;
  hasAltiumRestToken: boolean;
  createdAt: string;
}

export interface WorkspaceListResponse {
  workspaces: Workspace[];
}

export interface WorkspaceResponse {
  workspace: Workspace;
}

export interface CreateWorkspaceInput {
  altiumWorkspaceUrl?: string;
  nexarClientId: string;
  nexarClientSecret: string;
  altiumRestToken?: string;
  testBeforeStore?: boolean;
}

export interface UpdateWorkspaceInput {
  altiumWorkspaceUrl?: string | null;
  nexarClientId?: string;
  nexarClientSecret?: string;
  altiumRestToken?: string | null;
  testBeforeStore?: boolean;
}

export interface TestConnectionInput {
  nexarClientId: string;
  nexarClientSecret: string;
}

export interface TestConnectionOk {
  ok: true;
}

// ── Types returned by /api/orgs/:orgId/members + /api/orgs/:orgId/invites ──

export type Role = "owner" | "admin" | "member" | "billing_only";

/** Subset of Role accepted by the invite create endpoint. */
export type InviteRole = "admin" | "member" | "billing_only";

export interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface MemberListResponse {
  members: Member[];
}

export interface MemberResponse {
  membership: {
    orgId: string;
    userId: string;
    role: Role;
    email: string;
    joinedAt: string;
  };
}

export interface ChangeRoleInput {
  role: Role;
}

export interface Invite {
  id: string;
  orgId: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface InviteListResponse {
  invites: Invite[];
}

export interface CreateInviteInput {
  email: string;
  role: InviteRole;
}

export interface CreateInviteResponse {
  invite: Invite;
  /** Plaintext token — round-trip into the accept URL the inviter shares. */
  token: string;
}

export interface AcceptInviteResponse {
  membership: {
    orgId: string;
    userId: string;
    role: Role;
    joinedAt: string;
  };
  org: { id: string; slug: string; name: string };
}

// ── Types returned by /api/orgs/:orgId/api-keys ───────────────────────

export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Populated only on the create response — never on listings. */
  preview?: string;
}

export interface ApiKeyListResponse {
  apiKeys: ApiKey[];
}

export interface CreateApiKeyInput {
  name: string;
  scopes?: string[];
  /** ISO-8601 string. Server rejects past dates with invalid_input. */
  expiresAt?: string;
}

export interface CreateApiKeyResponse {
  apiKey: ApiKey;
  /** Plaintext key — shown to the user EXACTLY ONCE. */
  key: string;
}

// ── Types returned by /api/billing/* ──────────────────────────────────

export interface BillingPlan {
  /** Stable name the SPA uses internally ("starter" / "team" / …). */
  name: string;
  /** Stripe Price id — passed back to checkout-session. */
  priceId: string;
  /** Display name for the SPA's plan picker. */
  label: string;
}

export interface BillingPlansResponse {
  plans: BillingPlan[];
}

export interface CheckoutSessionInput {
  priceId: string;
  seats: number;
}

export interface CheckoutSessionResponse {
  url: string;
  sessionId: string;
}

export interface PortalSessionResponse {
  url: string;
}

// ── Types returned by /api/orgs/:orgId/usage ──────────────────────────

export interface UsageMetric {
  used: number;
  /** `null` means unlimited (Enterprise). UI renders "∞". */
  limit: number | null;
}

export interface UsageReport {
  period: { start: string; end: string };
  plan: { name: string; overageAllowed: boolean };
  /**
   * Keyed by metric name (`bom_lookup` / `cost_analysis` / `export`).
   * Every known metric appears with `used: 0` when there are no rows.
   */
  metrics: Record<string, UsageMetric>;
  /**
   * Keyed by tool name (`search_parts`, `analyze_bom_cost`, …).
   * Only spec §4.4 metered tools appear; missing tools default to 0.
   */
  byTool: Record<string, number>;
}

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

  // ─── Workspace CRUD ────────────────────────────────────────────────
  listWorkspaces: (orgId: string) =>
    call<WorkspaceListResponse>(`/api/orgs/${encodeURIComponent(orgId)}/workspaces`),

  getWorkspace: (orgId: string, workspaceId: string) =>
    call<WorkspaceResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`
    ),

  createWorkspace: (orgId: string, input: CreateWorkspaceInput) =>
    call<WorkspaceResponse>(`/api/orgs/${encodeURIComponent(orgId)}/workspaces`, {
      method: "POST",
      body: input,
    }),

  updateWorkspace: (orgId: string, workspaceId: string, input: UpdateWorkspaceInput) =>
    call<WorkspaceResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: "PATCH", body: input }
    ),

  deleteWorkspace: (orgId: string, workspaceId: string) =>
    call<{ ok: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" }
    ),

  testWorkspaceConnection: (orgId: string, input: TestConnectionInput) =>
    call<TestConnectionOk>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/test-connection`,
      { method: "POST", body: input }
    ),

  // ─── Tenant-scoped Nexar (PR 2.3 routes) ───────────────────────────
  searchParts: (orgId: string, workspaceId: string, query: string, limit = 10) =>
    call<PartSearchResult[]>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(
        workspaceId
      )}/parts/search?query=${encodeURIComponent(query)}&limit=${limit}`
    ),

  checkAvailability: (orgId: string, workspaceId: string, mpn: string) =>
    call<PartAvailabilitySummary | { notFound: true; mpn: string }>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(
        workspaceId
      )}/parts/availability?mpn=${encodeURIComponent(mpn)}`
    ),

  findAlternatives: (orgId: string, workspaceId: string, mpn: string, criteria: string) =>
    call<
      | {
          originalPart: string;
          criteria: string;
          alternatives: PartSearchResult[];
          note: string;
        }
      | { notFound: true; mpn: string }
    >(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(
        workspaceId
      )}/parts/alternatives?mpn=${encodeURIComponent(mpn)}&criteria=${encodeURIComponent(
        criteria
      )}`
    ),

  listLibraryComponents: (
    orgId: string,
    workspaceId: string,
    altiumWorkspaceUrl?: string
  ) => {
    const qs = altiumWorkspaceUrl
      ? `?altiumWorkspaceUrl=${encodeURIComponent(altiumWorkspaceUrl)}`
      : "";
    return call<AltiumComponent[]>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(
        workspaceId
      )}/library/components${qs}`
    );
  },

  listAltium365Workspaces: (orgId: string, workspaceId: string) =>
    call<{ workspaces: AltiumWorkspace[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(
        workspaceId
      )}/altium-365/workspaces`
    ),

  listAltium365Projects: (
    orgId: string,
    workspaceId: string,
    altiumWorkspaceUrl?: string
  ) => {
    const qs = altiumWorkspaceUrl
      ? `?altiumWorkspaceUrl=${encodeURIComponent(altiumWorkspaceUrl)}`
      : "";
    return call<{ projects: AltiumProject[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(
        workspaceId
      )}/altium-365/projects${qs}`
    );
  },

  // ─── Members ───────────────────────────────────────────────────────
  listMembers: (orgId: string) =>
    call<MemberListResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/members`
    ),

  changeMemberRole: (orgId: string, userId: string, input: ChangeRoleInput) =>
    call<MemberResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: input }
    ),

  removeMember: (orgId: string, userId: string) =>
    call<{ ok: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    ),

  // ─── Invites ───────────────────────────────────────────────────────
  listInvites: (orgId: string) =>
    call<InviteListResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/invites`
    ),

  createInvite: (orgId: string, input: CreateInviteInput) =>
    call<CreateInviteResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/invites`,
      { method: "POST", body: input }
    ),

  revokeInvite: (orgId: string, inviteId: string) =>
    call<{ ok: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" }
    ),

  acceptInvite: (token: string) =>
    call<AcceptInviteResponse>(
      `/api/invites/${encodeURIComponent(token)}/accept`,
      { method: "POST" }
    ),

  // ─── API keys ──────────────────────────────────────────────────────
  listApiKeys: (orgId: string) =>
    call<ApiKeyListResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/api-keys`
    ),

  createApiKey: (orgId: string, input: CreateApiKeyInput) =>
    call<CreateApiKeyResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/api-keys`,
      { method: "POST", body: input }
    ),

  revokeApiKey: (orgId: string, keyId: string) =>
    call<{ ok: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" }
    ),

  // ─── Billing ───────────────────────────────────────────────────────
  listBillingPlans: () =>
    call<BillingPlansResponse>("/api/billing/plans"),

  createCheckoutSession: (orgId: string, input: CheckoutSessionInput) =>
    call<CheckoutSessionResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/billing/checkout-session`,
      { method: "POST", body: input }
    ),

  createPortalSession: (orgId: string) =>
    call<PortalSessionResponse>(
      `/api/orgs/${encodeURIComponent(orgId)}/billing/portal-session`,
      { method: "POST" }
    ),

  // ─── Usage ─────────────────────────────────────────────────────────
  getUsage: (orgId: string) =>
    call<UsageReport>(`/api/orgs/${encodeURIComponent(orgId)}/usage`),

  health: () => call<{ ok: boolean; name: string; version: string }>("/api/health"),
};
