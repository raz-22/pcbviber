/**
 * Centralized audit-log writer. Used by every route that records a
 * security-relevant event (signup, login, logout, workspace.add, etc.).
 *
 * Two non-negotiable invariants:
 *   1. Audit failures NEVER bubble up to the caller. The whole point
 *      of the log is observability — if it's broken, that's a Sprint-6
 *      reliability ticket, not a 500 served to the user.
 *   2. The wire types accept a few odd inputs (unknown user-agent
 *      header, structured metadata) but always store something safe
 *      and bounded. No JSON.stringify circular failures, no >512-byte
 *      user-agent rows.
 */

import { prisma } from "@altium-mcp/db";

export interface AuditWrite {
  orgId: string;
  actorUserId?: string | null;
  /**
   * Action verb. Use a stable vocabulary so log queries don't need
   * fuzzy matches. Existing actions:
   *   signup | login | logout
   *   workspace.add | workspace.update | workspace.delete | workspace.test_connection
   * Future: api_key.create / .revoke, member.add / .remove / .role_change, etc.
   */
  action: string;
  target?: string;
  ip?: string;
  userAgent?: unknown;
  metadata?: Record<string, unknown>;
}

const MAX_USER_AGENT = 512;
const MAX_METADATA_BYTES = 4096; // bounded so a runaway log entry can't eat the row

export async function writeAuditLog(entry: AuditWrite): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: entry.orgId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        target: entry.target,
        ip: entry.ip,
        userAgent:
          typeof entry.userAgent === "string"
            ? entry.userAgent.slice(0, MAX_USER_AGENT)
            : null,
        metadata: serializeMetadata(entry.metadata),
      },
    });
  } catch {
    // Never fail the caller because the audit log misbehaves. Real
    // observability of audit-log failures is Sprint 6 work.
  }
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  let json: string;
  try {
    json = JSON.stringify(metadata);
  } catch {
    // Circular ref or BigInt — fall back to a shallow {key: typeof}
    // dump so the log row still has something searchable.
    const safe: Record<string, string> = {};
    for (const k of Object.keys(metadata)) safe[k] = typeof metadata[k];
    json = JSON.stringify(safe);
  }
  if (json.length > MAX_METADATA_BYTES) {
    return JSON.stringify({ truncated: true, prefix: json.slice(0, 256) });
  }
  return json;
}

/**
 * Pull `ip` from `x-forwarded-for` (first segment) or `req.ip`. Used
 * by every route that writes an audit entry — same logic shared so
 * the IP we record matches across actions.
 */
export function clientIp(req: {
  ip?: string;
  headers: Record<string, unknown>;
}): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]?.trim();
  }
  return req.ip;
}
