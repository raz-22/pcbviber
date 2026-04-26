/**
 * Per-org IP allowlist matcher.
 *
 * Operators store a JSON-encoded array of IP / CIDR strings on
 * `Organization.ipAllowlistJson`. When that array is null OR
 * empty, the allowlist is "disabled" — the org accepts any source
 * IP (preserves the pre-PR-7.4 behavior). When non-empty, every
 * tenant-scoped request is checked against the array; misses get
 * 403'd.
 *
 * Supports IPv4, IPv6, and IPv4-mapped-IPv6 (`::ffff:127.0.0.1`,
 * which is what Node sees on dual-stack sockets when the client
 * connects over IPv4). `ipaddr.js` handles all three.
 *
 * Pure functions — no DB, no Fastify. Tests pin the matcher
 * without spinning up the route layer.
 */

import ipaddr from "ipaddr.js";

/**
 * Maximum number of entries we allow on a single org. 50 covers
 * realistic small-team setups (3–10 office IPs + a handful of
 * VPN ranges) with comfortable headroom; rejecting massive lists
 * up-front prevents DoS via a giant allowlist on the hot path.
 */
export const MAX_ENTRIES = 50;

/**
 * Validate one allowlist entry. Returns the canonical form on
 * success (so the matcher and the storage agree on representation),
 * or null on any parse failure. Accepts:
 *
 *   - Plain IPv4: "203.0.113.5"
 *   - IPv4 CIDR:  "203.0.113.0/24"
 *   - Plain IPv6: "2001:db8::1"
 *   - IPv6 CIDR:  "2001:db8::/32"
 *
 * Rejects everything else (hostnames, glob patterns, ranges).
 */
export function normalizeEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;

  if (trimmed.includes("/")) {
    try {
      const [addr, prefix] = ipaddr.parseCIDR(trimmed);
      return `${addr.toNormalizedString()}/${prefix}`;
    } catch {
      return null;
    }
  }
  try {
    const addr = ipaddr.parse(trimmed);
    return addr.toNormalizedString();
  } catch {
    return null;
  }
}

/**
 * Parse the raw `ipAllowlistJson` column. Returns:
 *   - null      if the column is null OR a parse error
 *   - []        if the column is an empty array
 *   - string[]  the normalized entries
 *
 * The route layer treats `null` and `[]` identically (both =
 * allowlist disabled). The distinction is preserved for the GET
 * /ip-allowlist endpoint so the SPA can tell "never configured"
 * apart from "set, then cleared back to empty."
 */
export function parseAllowlist(raw: string | null): string[] | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const norm = normalizeEntry(item);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Test whether `clientIp` matches at least one entry in the
 * normalized allowlist. Returns true when:
 *
 *   - allowlist is null OR empty (allowlist disabled)
 *   - clientIp parses + matches at least one entry
 *
 * Returns false on any parse failure of the client IP. That's
 * fail-closed: if we can't tell what the client's IP is, we don't
 * let them through.
 *
 * Handles IPv4-mapped IPv6 by unwrapping to v4 before comparing
 * against v4 entries — `::ffff:203.0.113.5` matches the entry
 * `203.0.113.5` (and a v4 CIDR containing it).
 */
export function isAllowed(
  clientIp: string | null | undefined,
  allowlist: string[] | null
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (typeof clientIp !== "string" || clientIp.length === 0) return false;

  let client: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    client = ipaddr.parse(clientIp);
  } catch {
    return false;
  }

  // Unwrap IPv4-mapped IPv6 so `::ffff:1.2.3.4` matches v4 entries.
  let clientV4: ipaddr.IPv4 | null = null;
  if (client.kind() === "ipv6" && (client as ipaddr.IPv6).isIPv4MappedAddress()) {
    clientV4 = (client as ipaddr.IPv6).toIPv4Address();
  } else if (client.kind() === "ipv4") {
    clientV4 = client as ipaddr.IPv4;
  }

  for (const entry of allowlist) {
    if (entry.includes("/")) {
      try {
        const [addr, prefix] = ipaddr.parseCIDR(entry);
        if (addr.kind() === "ipv4" && clientV4) {
          if (clientV4.match([addr as ipaddr.IPv4, prefix])) return true;
        } else if (addr.kind() === "ipv6" && client.kind() === "ipv6") {
          if ((client as ipaddr.IPv6).match([addr as ipaddr.IPv6, prefix])) {
            return true;
          }
        }
      } catch {
        // Skip malformed entry — `parseAllowlist` filters these
        // out, so we shouldn't see them, but defense in depth.
      }
      continue;
    }
    try {
      const addr = ipaddr.parse(entry);
      if (addr.kind() === "ipv4" && clientV4) {
        if (clientV4.toNormalizedString() === addr.toNormalizedString()) {
          return true;
        }
      } else if (addr.kind() === "ipv6" && client.kind() === "ipv6") {
        if (
          (client as ipaddr.IPv6).toNormalizedString() ===
          (addr as ipaddr.IPv6).toNormalizedString()
        ) {
          return true;
        }
      }
    } catch {
      /* skip */
    }
  }
  return false;
}
