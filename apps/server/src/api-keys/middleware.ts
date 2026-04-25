/**
 * Bearer-token middleware for the MCP transport.
 *
 * Verifies `Authorization: Bearer <plaintext>`, hashes the plaintext,
 * looks up the ApiKey row, rejects revoked/expired keys, and populates
 * `req.apiKeyCtx` with the resolved key + org. Mounts on POST /mcp so
 * every MCP request carries a tenant-bound context.
 *
 * Failure shape: every rejection path returns 401 with the same body
 * (`{ error: "not_authenticated" }`) and `WWW-Authenticate: Bearer`.
 * Identical responses for "no header", "wrong scheme", "unknown key",
 * "revoked key", and "expired key" — an attacker probing the endpoint
 * can't distinguish "this token doesn't exist" from "this token used
 * to be valid but was revoked," so leaked-then-revoked tokens don't
 * become an enumeration vector.
 *
 * lastUsedAt is updated on every accepted request as a fire-and-forget
 * write; an audit-log row is NOT written for each accept (would flood
 * the table on a busy /mcp endpoint). Failed-auth attempts are also
 * unaudited for the same reason — drowning real signal in noise from
 * scanners and broken clients.
 *
 * Tool-handler integration: this middleware doesn't yet pass req.apiKeyCtx
 * into buildMcpServer — tools continue to use the env-loaded NexarService
 * singleton wired in Sprint 2. Cutting tools over to per-tenant resolution
 * (factory.forWorkspace) is a separate effort; this PR's job is just to
 * gate the transport.
 */

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { prisma } from "@altium-mcp/db";
import { hashApiKey } from "./keys.js";
import { tagRequestApiKey } from "../observability/sentry.js";

const BEARER_PREFIX_LEN = "Bearer ".length;

/**
 * RFC 7235 §2.1: the auth-scheme is case-insensitive, so a header like
 * `bearer pcb_…` or `BEARER pcb_…` must validate the same as
 * `Bearer pcb_…`. Most real clients send capitalized `Bearer`, but
 * matching strictly would 401 a perfectly valid token from a
 * non-conforming client.
 */
const BEARER_PREFIX_RE = /^Bearer /i;

/** Per-request context populated by makeRequireApiKey. */
export interface ApiKeyContext {
  apiKey: {
    id: string;
    orgId: string;
    name: string;
    /** Parsed from the space-joined `scopes` column. */
    scopes: string[];
  };
  org: {
    id: string;
    slug: string;
    name: string;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by makeRequireApiKey when a bearer-token request validates. */
    apiKeyCtx?: ApiKeyContext;
  }
}

/**
 * Centralized 401 response. Every failure path returns this exact
 * body + headers — see top-of-file for the reasoning.
 */
function reject(reply: FastifyReply): void {
  reply.header("WWW-Authenticate", 'Bearer realm="api"');
  reply.code(401);
}

export function makeRequireApiKey(): preHandlerAsyncHookHandler {
  return async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !BEARER_PREFIX_RE.test(header)) {
      reject(reply);
      throw new Error("not_authenticated");
    }
    const plaintext = header.slice(BEARER_PREFIX_LEN).trim();
    if (!plaintext) {
      reject(reply);
      throw new Error("not_authenticated");
    }

    const hashed = hashApiKey(plaintext);
    const row = await prisma.apiKey.findUnique({
      where: { hashedKey: hashed },
      include: {
        org: { select: { id: true, slug: true, name: true } },
      },
    });
    if (!row) {
      reject(reply);
      throw new Error("not_authenticated");
    }
    if (row.revokedAt) {
      reject(reply);
      throw new Error("not_authenticated");
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      reject(reply);
      throw new Error("not_authenticated");
    }

    // Fire-and-forget lastUsedAt bump. A failed write must NOT fail
    // the request — observability of the bump itself is observability
    // (next call will retry it), and we don't want a transient DB
    // hiccup to block tool calls.
    prisma.apiKey
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    req.apiKeyCtx = {
      apiKey: {
        id: row.id,
        orgId: row.orgId,
        name: row.name,
        scopes: row.scopes ? row.scopes.split(" ").filter(Boolean) : [],
      },
      org: row.org,
    };
    // Attach tenant + api-key attribution to the current Sentry
    // scope. Inert when SENTRY_DSN is unset. Same reasoning as
    // tenant.ts: app-level preHandler hooks run before
    // route-level ones, so we tag here where the context exists.
    tagRequestApiKey(req.apiKeyCtx);
  };
}

/**
 * Centralized error handler so the 401 body matches the shape the
 * rest of the API uses (`{ error: "not_authenticated" }`). Mount once
 * with `installApiKeyErrorHandler(app)` after the routes are
 * registered. Without this, Fastify's default error renderer would
 * emit `{statusCode, error, message}` — which is fine for humans but
 * inconsistent with the SPA's mapper.
 */
export function installApiKeyErrorHandler(app: import("fastify").FastifyInstance): void {
  // Defer to whatever handler is already installed for non-401 errors.
  // A 401 thrown by requireApiKey gets reshaped here; everything else
  // bubbles to Fastify's default.
  const previous = app.errorHandler;
  app.setErrorHandler((err, req, reply) => {
    const status = reply.statusCode;
    if (status === 401 && err instanceof Error && err.message === "not_authenticated") {
      reply.code(401).send({ error: "not_authenticated" });
      return;
    }
    previous(err, req, reply);
  });
}
