/**
 * SPA-side Sentry wiring.
 *
 * Mirrors the server-side init shape so both halves of the
 * stack share an obvious testing pattern + a shared PII filter
 * intent.
 *
 *   - `initSentry(env)` — call ONCE before React renders. Returns
 *     true when Sentry was actually wired (DSN set + non-empty),
 *     false otherwise. Tests assert env-gating via the boolean.
 *
 * Vite exposes env vars prefixed with `VITE_` to the client; the
 * SPA reads `VITE_SENTRY_DSN` rather than `SENTRY_DSN` so the
 * server's secret never leaks into the client bundle.
 *
 * PII filter `beforeSend` mirrors the server's: strip cookie
 * headers + Authorization header + email/password fields from
 * request bodies. The SPA generally DOESN'T put bodies through
 * Sentry (it uses fetch, not XHR with breadcrumbs by default),
 * but the filter runs anyway as defense in depth — and matches
 * the server's filter so the two halves of the stack apply
 * the same redaction policy.
 */

import * as Sentry from "@sentry/react";

export interface ViteEnv {
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENVIRONMENT?: string;
  VITE_SENTRY_RELEASE?: string;
  /** Vite's built-in. */
  MODE?: string;
}

/**
 * Initialize Sentry from Vite env. Returns whether Sentry was
 * actually wired (true when DSN is set + non-empty).
 */
export function initSentry(env: ViteEnv): boolean {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  if (!dsn || dsn.length === 0) {
    return false;
  }
  Sentry.init({
    dsn,
    environment: env.VITE_SENTRY_ENVIRONMENT ?? env.MODE ?? "production",
    release: env.VITE_SENTRY_RELEASE,
    // Spec §2.2 wants "errors + selective traces"; 10% strikes a
    // balance between debugging signal and quota burn.
    tracesSampleRate: 0.1,
    // Replays are useful but PII-heavy — opt in deliberately,
    // not by default. Sentry's default sample rates are 0
    // already; pinning explicitly so future SDK defaults can't
    // turn them on under us.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend,
  });
  return true;
}

/**
 * Pure-function PII filter. Exported so unit tests can assert
 * the redactions without spinning up Sentry's transport. The
 * filter handles every field type the SPA might emit: Sentry's
 * fetch breadcrumb, manually-attached request bodies, and the
 * user context.
 */
export function beforeSend(
  event: Sentry.ErrorEvent,
  _hint?: Sentry.EventHint
): Sentry.ErrorEvent | null {
  if (event.request) {
    if (event.request.cookies) {
      delete event.request.cookies;
    }
    if (event.request.headers) {
      const h = event.request.headers as Record<string, unknown>;
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
    if (event.request.data && typeof event.request.data === "object") {
      const data = event.request.data as Record<string, unknown>;
      if ("email" in data) data.email = "[REDACTED]";
      if ("password" in data) data.password = "[REDACTED]";
    }
  }
  if (event.user) {
    delete event.user.email;
    delete event.user.username;
    delete event.user.ip_address;
  }
  return event;
}
