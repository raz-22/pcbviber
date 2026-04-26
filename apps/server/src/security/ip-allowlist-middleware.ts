/**
 * Org IP-allowlist enforcement, exposed as a function the auth
 * middlewares call inline once they've populated their context
 * (`req.ctx` for REST, `req.apiKeyCtx` for the MCP transport).
 *
 * Why inline rather than a Fastify preHandler:
 *   - Fastify runs app-level preHandler hooks BEFORE route-level
 *     preHandler arrays (we hit this in PR 6.6c). A separate
 *     enforcement preHandler would either run too early (no ctx
 *     yet) or require us to touch every route file to add a third
 *     entry to its `preHandler: [...]`.
 *   - Calling the check from `makeRequireOrgRole` / `makeRequireApiKey`
 *     keeps "is this caller allowed to access this org?" in one
 *     place per surface, alongside the role check.
 *
 * On a miss, throws an Error("ip_not_allowed") with reply.code(403)
 * already set — same pattern the rest of the auth middlewares use,
 * so the error handler chain reshapes the body uniformly.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { isAllowed, parseAllowlist } from "./ip-allowlist.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";

export interface IpAllowlistCheckArgs {
  orgId: string;
  /** Raw `Organization.ipAllowlistJson`. */
  allowlistJson: string | null;
  /** Acting user, when known (REST). null on MCP. */
  actorUserId: string | null;
  /** ApiKey id, when this is an MCP-transport request. null otherwise. */
  apiKeyId: string | null;
}

/**
 * Run the IP-allowlist check against `req`. No-op when the org's
 * allowlist is null/empty. On a miss: writes an `ip_allowlist.block`
 * audit row and throws — caller is expected to be inside a Fastify
 * preHandler so the throw propagates to the error handler.
 */
export async function checkIpAllowlistOrThrow(
  req: FastifyRequest,
  reply: FastifyReply,
  args: IpAllowlistCheckArgs
): Promise<void> {
  const allowlist = parseAllowlist(args.allowlistJson);
  if (!allowlist || allowlist.length === 0) return;

  const ip = clientIp(req) ?? null;
  if (isAllowed(ip, allowlist)) return;

  // Block + audit. The audit row records the rejected attempt, not a
  // successful access — operators see denied requests in the same
  // log as legitimate ones.
  await writeAuditLog({
    orgId: args.orgId,
    actorUserId: args.actorUserId,
    action: "ip_allowlist.block",
    ip: ip ?? undefined,
    userAgent: req.headers["user-agent"],
    metadata: {
      method: req.method,
      path: req.url,
      apiKeyId: args.apiKeyId,
      allowlistSize: allowlist.length,
    },
  });

  reply.code(403);
  throw new Error("ip_not_allowed");
}
