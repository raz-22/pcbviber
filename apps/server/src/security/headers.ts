/**
 * Security headers — Content-Security-Policy, HSTS, X-Frame-Options,
 * X-Content-Type-Options, Referrer-Policy. All driven by
 * `@fastify/helmet`.
 *
 * The big-picture choices:
 *
 *   - **CSP** is tight in production (`default-src 'self'`, no
 *     externals, `frame-ancestors 'none'`). In dev it relaxes to
 *     allow Vite's HMR websocket on `:5173`.
 *
 *   - **HSTS** is enabled only in production. Once a browser sees
 *     `Strict-Transport-Security`, it locks the host to HTTPS for
 *     `max-age` seconds — accidentally setting it in dev would
 *     poison `localhost` for a year.
 *
 *   - **X-Frame-Options: DENY** + the modern equivalent
 *     `frame-ancestors 'none'` in CSP. Belt and suspenders against
 *     clickjacking; older browsers that don't honor CSP still get
 *     the X-Frame header.
 *
 *   - **No `preload`** on HSTS. Submitting to the Chromium preload
 *     list is a one-way commitment we don't make implicitly — if
 *     we want it, that's a deliberate launch-day decision.
 */

import type { FastifyHelmetOptions } from "@fastify/helmet";

/**
 * Returns the helmet config for the current environment. Pulls
 * NODE_ENV from `env` so callers can override for tests (we toggle
 * it to verify HSTS turns on / off).
 */
export function helmetOptionsFor(env: NodeJS.ProcessEnv): FastifyHelmetOptions {
  const isProd = env.NODE_ENV === "production";

  // CSP directives:
  //   default-src 'self'   — everything not otherwise whitelisted
  //                          must come from the same origin
  //   script-src 'self'    — no inline scripts; the SPA bundles
  //   style-src 'self' 'unsafe-inline'
  //                       — Tailwind's utility classes generate
  //                          inline style attributes; without this
  //                          the SPA renders unstyled. Hash-based
  //                          allowlisting is overkill for a small
  //                          internal SPA.
  //   img-src 'self' data: — data: URLs for tiny inline icons
  //   connect-src 'self'   — REST + MCP go to the same origin;
  //                          tightened from the helmet default
  //                          which allows everything
  //   frame-ancestors 'none' — cannot be embedded in any iframe
  //   base-uri 'self'      — locks down <base> tag injection
  //   form-action 'self'   — forms can only POST back to us
  const baseDirectives = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };

  // Dev relaxations: Vite's dev server runs HMR over a ws://
  // connection; without this, the SPA can't refresh on save.
  // The connect-src allow-list expands; everything else stays
  // tight so dev doesn't drift from prod's CSP.
  const devOnlyConnect: string[] = isProd
    ? []
    : [
        "ws://localhost:5173",
        "ws://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ];

  const directives: Record<string, string[]> = {
    ...baseDirectives,
    "connect-src": [...baseDirectives["connect-src"], ...devOnlyConnect],
  };

  return {
    contentSecurityPolicy: {
      directives,
      // useDefaults: false so helmet's defaults don't paper over
      // ours. Whatever we don't list, the browser falls back to
      // default-src — which is 'self'.
      useDefaults: false,
    },
    // HSTS is the most consequential header — only set in prod.
    strictTransportSecurity: isProd
      ? {
          maxAge: 365 * 24 * 60 * 60, // 1 year
          includeSubDomains: true,
          preload: false,
        }
      : false,
    // X-Frame-Options: DENY. The CSP frame-ancestors directive is
    // the modern replacement; X-Frame-Options is the fallback for
    // browsers that don't yet honor it (vanishingly few in 2026,
    // but the header costs nothing).
    frameguard: { action: "deny" },
    // X-Content-Type-Options: nosniff. Stops the browser from
    // sniffing a response's content type when the server sets it
    // explicitly — closes a class of MIME-confusion attacks.
    noSniff: true,
    // Referrer-Policy: strict-origin-when-cross-origin. Send the
    // origin (not full URL) on cross-origin requests; full URL on
    // same-origin. Avoids leaking session-bearing query strings to
    // third parties via the Referer header.
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
    // Cross-origin isolation: dial these back to the helmet default
    // so the SPA + REST work without surprises. Tightening COEP /
    // COOP belongs with the rest of the launch hardening once the
    // production deploy topology (Cloudflare in front, separate
    // marketing site, etc.) is settled.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
  };
}
