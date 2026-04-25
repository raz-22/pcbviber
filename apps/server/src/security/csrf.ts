/**
 * CSRF protection — double-submit cookie pattern.
 *
 * Implementation: `@fastify/csrf-protection` with `sessionPlugin:
 * '@fastify/cookie'`. The plugin signs an HMAC token, sets it as
 * a cookie, and validates the matching `x-csrf-token` header on
 * incoming state-change requests.
 *
 * SPA flow:
 *   1. SPA calls `GET /api/csrf` on first state-change attempt.
 *      The route calls `reply.generateCsrf()` which sets the
 *      cookie + returns the token in JSON.
 *   2. SPA caches the token in memory; sends `x-csrf-token: <tok>`
 *      on every POST/PATCH/DELETE.
 *   3. Server's per-route `csrfProtection` preHandler validates
 *      header against cookie. Mismatch → 403.
 *
 * Routes that DON'T use the protection:
 *   - /mcp (Bearer token, not cookies — not CSRF-vulnerable)
 *   - /api/billing/webhook (Stripe HMAC, not session)
 *   - /api/auth/signup, /api/auth/login (no session yet → can't
 *     have a token to check)
 *   - GET /api/csrf itself (the bootstrap call)
 *   - Every GET (read-only, not state-changing)
 *
 * /api/invites/:token/accept IS protected — the URL token only
 * authorizes the join target, but the COOKIE authenticates the
 * caller, so a malicious link could trick a signed-in user into
 * accepting an invite they didn't intend to.
 *
 * The csrf-protection plugin throws a typed error on mismatch;
 * we install a small Fastify error handler that maps it to the
 * stable `csrf_invalid` code so the SPA mapper can detect it
 * and refetch the token transparently.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

/**
 * The two error codes `@fastify/csrf-protection` v7 throws on a
 * failed check (verified against the plugin source — see
 * `node_modules/.../@fastify/csrf-protection/index.js`). Pinned
 * here so the error handler doesn't depend on string matches
 * against the plugin's message text.
 */
const CSRF_ERROR_CODES = new Set([
  "FST_CSRF_MISSING_SECRET",
  "FST_CSRF_INVALID_TOKEN",
]);

/**
 * Reads the CSRF token off the `x-csrf-token` header. Used as the
 * plugin's `getToken` config so we don't depend on the body or
 * query string. The SPA's fetch wrapper sets this header on every
 * state-change request.
 */
export function getCsrfTokenFromHeader(req: FastifyRequest): string | undefined {
  const header = req.headers["x-csrf-token"];
  if (typeof header === "string" && header.length > 0) return header;
  return undefined;
}

/**
 * Returns the CSRF preHandler to mount on a route. When
 * `@fastify/csrf-protection` has been registered on `app`,
 * `app.csrfProtection` exists and we return it directly. Tests
 * (which register routes against a Fastify that doesn't include
 * the plugin — `app.inject()` isn't a browser, no CSRF needed)
 * get a no-op so the route registration still succeeds.
 *
 * Read at registration time, not request time — the route's
 * preHandler array gets the function reference once.
 */
export function csrfOrPassthrough(app: FastifyInstance): preHandlerAsyncHookHandler {
  const candidate = (app as { csrfProtection?: unknown }).csrfProtection;
  if (typeof candidate === "function") {
    return candidate as preHandlerAsyncHookHandler;
  }
  // Test path: no plugin → permit-everything. Real CSRF behavior
  // is verified by dedicated tests that DO register the plugin.
  return async (_req: FastifyRequest, _reply: FastifyReply) => {};
}

/**
 * Maps the plugin's 403 errors to the API-wide
 * `{ error: "csrf_invalid" }` body. Other errors fall through to
 * whatever handler was previously installed (so this composes
 * with `installApiKeyErrorHandler` and `installRateLimitErrorHandler`).
 *
 * Mount BEFORE installApiKeyErrorHandler.
 */
export function installCsrfErrorHandler(app: FastifyInstance): void {
  const previous = app.errorHandler;
  app.setErrorHandler((err, req, reply) => {
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && CSRF_ERROR_CODES.has(code)) {
      reply.code(403).send({ error: "csrf_invalid" });
      return;
    }
    previous(err, req, reply);
  });
}
