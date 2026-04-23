import type { FastifyInstance } from "fastify";
import { AdResultEnvelope } from "@altium-mcp/shared";
import type { AdRelay } from "./relay.js";

/**
 * Registers the /ad-relay/* HTTP routes on the Fastify instance.
 *
 * These are ONLY mounted when the server is started with --transport=http.
 * In stdio mode there's no HTTP surface; to use the AD relay, run the
 * server with HTTP transport.
 */
export function registerAdRelayRoutes(app: FastifyInstance, relay: AdRelay) {
  // AD → server: long-poll for the next command.
  // Returns 204 if no command arrives within the poll window (AD re-polls).
  app.get("/ad-relay/next", async (_req, reply) => {
    const cmd = await relay.nextCommand(25_000);
    if (!cmd) {
      reply.code(204);
      return null;
    }
    return cmd;
  });

  // AD → server: post the result for a dispatched command.
  app.post("/ad-relay/result", async (req, reply) => {
    const parsed = AdResultEnvelope.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid result envelope", detail: parsed.error.flatten() };
    }
    const outcome = relay.postResult(parsed.data);
    if (!outcome.accepted) {
      reply.code(410); // Gone — command id no longer tracked
      return { error: "result rejected", detail: outcome.reason };
    }
    return { ok: true };
  });

  // Diagnostics: anyone can GET this to see whether AD is connected.
  app.get("/ad-relay/status", async () => relay.status());
}
