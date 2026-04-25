/**
 * Per-route rate-limit configuration.
 *
 * Single source of truth for the limits the spec §3.6 calls out
 * plus a /mcp limit that's not in the spec but matches the
 * "per-key" intent.
 *
 * Limits are enforced by `@fastify/rate-limit`. Each route gets a
 * `RouteRateLimit` config attached via the route's
 * `config.rateLimit` field; the global plugin reads it and applies
 * the bucket. Routes without a config bypass the limit entirely.
 *
 * Storage:
 *   - When REDIS_URL is set, the plugin uses an ioredis-backed
 *     store so two replicas share the same bucket — without this,
 *     a horizontally-scaled deploy would let a brute-force
 *     attacker N× their effective rate by hitting different
 *     replicas.
 *   - When REDIS_URL is unset, the plugin falls back to its
 *     in-memory default. Acceptable for dev / tests.
 *
 * Error response:
 *   429 with `{ error: "rate_limited", detail: { retryAfterSeconds } }`
 *   plus a `Retry-After` header (seconds). Stable error code so the
 *   SPA mapper can show a friendly "you're moving too fast" copy.
 */

/**
 * Shape consumed directly by `@fastify/rate-limit` per-route
 * `config.rateLimit`. `timeWindow` is milliseconds (the plugin also
 * accepts strings like `"1 minute"`; we use ms for clarity).
 */
export interface RouteRateLimit {
  /** Max requests per `timeWindow`. */
  max: number;
  /** Window duration in milliseconds. */
  timeWindow: number;
  /**
   * Returns the bucket key per request. The plugin uses this to
   * partition limits — by IP for auth, by orgId for invites,
   * by API-key id for /mcp.
   */
  keyGenerator: (req: import("fastify").FastifyRequest) => string;
}

// ── Limits per spec §3.6 ─────────────────────────────────────────────

/**
 * Auth endpoints: 5 / minute / IP. Brute-force defense — a single
 * attacker burning through password guesses gets stopped at 5/min,
 * which makes credential-stuffing economically uninteresting.
 *
 * keyGenerator uses x-forwarded-for first (the SPA may sit behind
 * Cloudflare / Fly's proxy) so different attackers behind the same
 * proxy don't share a bucket.
 */
export const AUTH_RATE_LIMIT: RouteRateLimit = {
  max: 5,
  timeWindow: 60_000,
  keyGenerator: (req) => `auth:${clientIp(req)}`,
};

/**
 * Invite POSTs: 10 / hour / org. Stops a compromised owner/admin
 * account (or a runaway script) from spam-inviting users to fill
 * the Membership table. orgId comes from the URL param the route
 * already binds.
 */
export const INVITE_RATE_LIMIT: RouteRateLimit = {
  max: 10,
  timeWindow: 60 * 60 * 1000,
  keyGenerator: (req) => {
    const orgId = (req.params as { orgId?: string })?.orgId ?? "unknown";
    return `invite:${orgId}`;
  },
};

/**
 * /mcp: 60 / minute / API-key. Spec calls for "per-key" without a
 * specific number. 60/min lets a typical AI-agent burst through
 * a tool workflow without tripping; revisit if customers complain
 * or we see a pattern of agents getting throttled.
 *
 * Falls back to the IP when apiKeyCtx isn't populated (the
 * api-key middleware would 401 first, but defense in depth — a
 * misconfigured route shouldn't accidentally bypass the bucket).
 */
export const MCP_RATE_LIMIT: RouteRateLimit = {
  max: 60,
  timeWindow: 60_000,
  keyGenerator: (req) => {
    const id = req.apiKeyCtx?.apiKey.id;
    return id ? `mcp:${id}` : `mcp:ip:${clientIp(req)}`;
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve client IP for keying. Same logic the audit log uses:
 * x-forwarded-for first (real client when behind a proxy), else
 * Fastify's req.ip.
 */
function clientIp(req: import("fastify").FastifyRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

/**
 * Marker property attached to the Error the rate-limit plugin
 * throws. The global error handler uses presence of this key to
 * distinguish "this is a rate-limit error" from any other error
 * shape, and reshapes the response into our `{ error, detail }`
 * convention.
 *
 * Exposed so the error-handler installer can reference it without
 * duplicating the literal.
 */
export const RATE_LIMIT_MARKER = "__altiumRateLimit" as const;

export interface RateLimitErrorMarker {
  retryAfterSeconds: number;
}

/**
 * Builder passed to `@fastify/rate-limit`'s `errorResponseBuilder`.
 * Returns an Error (the plugin throws what we return; Fastify's
 * error pipeline expects a thrown value with `statusCode`). The
 * `[RATE_LIMIT_MARKER]` field lets `installRateLimitErrorHandler`
 * recognize the error and reshape it to the API-wide
 * `{ error: "rate_limited", detail: { retryAfterSeconds } }` body.
 */
export function rateLimitErrorBuilder(
  _req: import("fastify").FastifyRequest,
  ctx: { statusCode: number; ttl: number }
): Error {
  const err = new Error("rate_limited") as Error & {
    statusCode: number;
    [RATE_LIMIT_MARKER]: RateLimitErrorMarker;
  };
  err.statusCode = ctx.statusCode;
  err[RATE_LIMIT_MARKER] = {
    retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
  };
  return err;
}

/**
 * Installs a Fastify error handler that reshapes rate-limit errors
 * into the API-wide `{ error: "rate_limited", detail: { … } }`
 * body. Other errors flow through to whatever handler was
 * previously installed (so this composes with
 * `installApiKeyErrorHandler`).
 *
 * Mount BEFORE `installApiKeyErrorHandler` so the api-key handler
 * stays the outermost wrapper for unhandled errors (it has the
 * fallback to Fastify's default behavior).
 */
export function installRateLimitErrorHandler(
  app: import("fastify").FastifyInstance
): void {
  const previous = app.errorHandler;
  app.setErrorHandler((err, req, reply) => {
    if (err && typeof err === "object" && RATE_LIMIT_MARKER in err) {
      const e = err as unknown as {
        statusCode?: number;
        [RATE_LIMIT_MARKER]: RateLimitErrorMarker;
      };
      reply.code(typeof e.statusCode === "number" ? e.statusCode : 429).send({
        error: "rate_limited",
        detail: e[RATE_LIMIT_MARKER],
      });
      return;
    }
    previous(err, req, reply);
  });
}
