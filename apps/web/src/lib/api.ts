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

  health: () => call<{ ok: boolean; name: string; version: string }>("/api/health"),
};
