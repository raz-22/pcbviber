/**
 * Server-side Sentry wiring.
 *
 * Three exports:
 *
 *   - `initSentry(env)` — call ONCE at process start, BEFORE any
 *     other module imports. Sentry's instrumentation works by
 *     monkey-patching at require-time; importing http / pg / etc.
 *     before init means those modules ship without traces.
 *
 *   - `tagRequestUser(ctx)` / `tagRequestApiKey(ctx)` — set tenant
 *     attribution on the current request's Sentry scope. Call from
 *     inside the auth middleware, AFTER req.ctx (or req.apiKeyCtx)
 *     is populated. Sentry's @sentry/node v10 uses async-context
 *     tracking, so tags set during a route's preHandler attach to
 *     just that request's scope. We do NOT use a Fastify app-level
 *     `addHook("preHandler", ...)` for this — those run BEFORE
 *     route-level preHandlers, so req.ctx would be undefined.
 *
 *   - `beforeSend` — pure-function PII filter wired as the SDK's
 *     beforeSend hook. Exported so unit tests can pin the
 *     redactions without spinning up the SDK transport.
 *
 * Env-gated: `SENTRY_DSN` empty / unset → `initSentry` is a no-op.
 * Calling Sentry.captureX / setUser / setTag in a no-op-init
 * process is also inert (the SDK guards internally). That keeps
 * dev / tests from needing to know whether Sentry is wired.
 *
 * PII filter strips email + auth headers + cookies before the
 * event hits Sentry's wire. The filter runs on both error events
 * and transactions so traces don't leak what errors don't.
 */

import * as Sentry from "@sentry/node";
import type { TransactionEvent } from "@sentry/core";

/**
 * Initialize Sentry from env. Returns whether Sentry was actually
 * wired (true when DSN is set + non-empty). Tests use the boolean
 * to assert env-gating without poking at Sentry's internals.
 */
export function initSentry(env: NodeJS.ProcessEnv): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn || dsn.length === 0) {
    return false;
  }
  Sentry.init({
    dsn,
    environment: env.NODE_ENV ?? "production",
    release: env.SENTRY_RELEASE,
    // Spec §2.2 wants "errors + selective traces"; 10% strikes
    // a balance — enough signal to debug a slow path, not enough
    // to burn the project's transaction quota during a hot loop.
    tracesSampleRate: 0.1,
    beforeSend,
    beforeSendTransaction,
  });
  return true;
}

/**
 * Tag the current Sentry scope with cookie-session tenant +
 * user attribution. Call from inside the auth/tenant middleware
 * AFTER `req.ctx = { ... }` is populated. Inert when Sentry isn't
 * configured — the SDK's setUser/setTag are no-ops in that case,
 * so call sites don't need to know.
 */
export function tagRequestUser(ctx: {
  user: { id: string };
  org: { id: string };
}): void {
  Sentry.setUser({ id: ctx.user.id });
  Sentry.setTag("tenantId", ctx.org.id);
}

/**
 * Tag the current Sentry scope with API-key tenant attribution.
 * Call from inside the api-key middleware AFTER `req.apiKeyCtx`
 * is populated. No user.id (the MCP transport has no user — only
 * a tenant-bound API key).
 */
export function tagRequestApiKey(ctx: {
  apiKey: { id: string };
  org: { id: string };
}): void {
  Sentry.setTag("tenantId", ctx.org.id);
  Sentry.setTag("apiKeyId", ctx.apiKey.id);
}

/**
 * Strips PII + credentials from an event before it leaves the
 * process. Exported so unit tests can assert the redactions
 * without running through Sentry's transport.
 *
 * What we strip:
 *   - `request.cookies` (entire object — drops every named cookie)
 *   - request headers: `authorization`, `cookie`, `x-csrf-token`
 *   - `request.data.email` / `password` (auth bodies)
 *   - `request.query_string.email` (rare but defensive)
 *   - `user.email` / `user.username` / `user.ip_address`
 *     (Sentry's user context; we set { id } only, but defense
 *     in depth catches future callsites that forget)
 */
export function beforeSend(
  event: Sentry.ErrorEvent,
  _hint?: Sentry.EventHint
): Sentry.ErrorEvent | null {
  if (event.request) {
    if (event.request.cookies) {
      // The whole object — Sentry's default doesn't redact session
      // cookies, and keeping any cookie is risky (the same value is
      // a credential to anyone who reads the event in Sentry UI).
      delete event.request.cookies;
    }
    if (event.request.headers) {
      const h = event.request.headers;
      // Iterate header names case-insensitively; Sentry preserves
      // the casing the request had.
      for (const key of Object.keys(h)) {
        const lower = key.toLowerCase();
        if (
          lower === "authorization" ||
          lower === "cookie" ||
          lower === "x-csrf-token"
        ) {
          delete h[key];
        }
      }
    }
    // request.data is the parsed body. Auth-related routes carry
    // email + password; never let either reach Sentry.
    if (event.request.data && typeof event.request.data === "object") {
      const data = event.request.data as Record<string, unknown>;
      if ("email" in data) data.email = "[REDACTED]";
      if ("password" in data) data.password = "[REDACTED]";
    }
    if (event.request.query_string && typeof event.request.query_string === "object") {
      const qs = event.request.query_string as Record<string, unknown>;
      if ("email" in qs) qs.email = "[REDACTED]";
    }
  }
  if (event.user) {
    delete event.user.email;
    delete event.user.username;
    delete event.user.ip_address;
  }
  return event;
}

/**
 * Same shape as `beforeSend` but for transactions (performance
 * traces). Sentry separates the two event types; the redactions
 * are identical, so we share the implementation.
 */
function beforeSendTransaction(
  event: TransactionEvent,
  _hint?: Sentry.EventHint
): TransactionEvent | null {
  // The filter only touches request / user — fields shared between
  // ErrorEvent and TransactionEvent. Run the same redactions and
  // cast back; the structural compatibility is real, the type
  // narrowing is just to satisfy Sentry's strict signature.
  return beforeSend(event as unknown as Sentry.ErrorEvent) as
    | TransactionEvent
    | null;
}
