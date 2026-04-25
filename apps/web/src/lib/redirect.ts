/**
 * Defensive redirect-target validator.
 *
 * The `from` field in router state is set by RequireAuth from the
 * user's own URL — but `location.state` is mutable from anywhere
 * (browser extensions, future code, malicious bookmarklets). Treating
 * it as untrusted prevents an open-redirect bug from ever existing in
 * this codebase.
 *
 * A "safe" redirect target is:
 *   - a non-empty string
 *   - that begins with exactly one `/`
 *   - and isn't a protocol-relative URL (`//evil.com`)
 *   - and doesn't contain a scheme (`javascript:`, `data:`, etc.)
 *
 * Anything else falls back to "/".
 */

const FALLBACK = "/" as const;

export function validateRedirectUrl(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return FALLBACK;
  if (!input.startsWith("/")) return FALLBACK;
  // protocol-relative URL: //evil.com → would navigate to evil.com
  if (input.startsWith("//")) return FALLBACK;
  // backslash variant — some routers / browsers treat \\ like //
  if (input.startsWith("/\\")) return FALLBACK;
  // any colon before the first / would be a scheme
  if (/^[^/]*:/.test(input)) return FALLBACK;
  return input;
}
