/**
 * Tenant-scoped Nexar routes — Sprint 2 PR 2.3.
 *
 * Mounts under `/api/orgs/:orgId/workspaces/:workspaceId/...`. Every
 * route chains `[requireAuth, requireOrgMember, makeRequireWorkspace()]`
 * so by the time a handler runs:
 *   - the user is authenticated
 *   - the user is a member of `:orgId`
 *   - the workspace exists AND belongs to that org
 * After all that, the handler loads a NexarService bound to the
 * workspace's encrypted creds via `factory.forWorkspace(...)` and
 * delegates to the same handler functions the MCP tools call.
 *
 * Handler functions are NOT modified — they stay
 * `(nexar, args) => result` so the MCP tool registrations in
 * tools/components.ts and tools/projects.ts keep working with the
 * env-loaded singleton until Sprint 3 cuts MCP transport over to
 * API-key-bound workspaces. Old `/api/parts/*` routes remain on the
 * server during the cutover; PR 2.4's SPA targets the new tenant-
 * scoped paths.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SearchPartsInput,
  CheckAvailabilityInput,
  FindAlternativePartsInput,
} from "@altium-mcp/shared";
import type { AuthProvider } from "@altium-mcp/auth";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole, makeRequireWorkspace } from "../auth/tenant.js";
import * as components from "../handlers/components.js";
import * as projects from "../handlers/projects.js";
import type { NexarServiceFactory } from "../services/nexar-factory.js";
import type { NexarService } from "../services/nexar.js";

export interface NexarRouteDeps {
  nexarFactory: NexarServiceFactory;
}

export async function registerNexarRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  deps: NexarRouteDeps
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireMember = makeRequireOrgRole([]);
  const requireWorkspace = makeRequireWorkspace();
  const { nexarFactory } = deps;

  /**
   * Loads + returns the NexarService for the current request's workspace.
   * Centralized so each route handler is one line and surfaces the
   * "no creds" / "decrypt failed" cases as 503 instead of 500.
   */
  async function loadNexarOr503(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply
  ): Promise<NexarService | null> {
    if (!req.workspace) {
      reply.code(500).send({ error: "missing_workspace_context" });
      return null;
    }
    if (!req.workspace.hasNexarCredentials) {
      reply.code(503).send({
        error: "workspace_not_configured",
        detail: "This workspace has no Nexar credentials. Add them in Settings.",
      });
      return null;
    }
    try {
      return await nexarFactory.forWorkspace(req.workspace.id);
    } catch (err) {
      reply.code(503).send({
        error: "workspace_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Parts ────────────────────────────────────────────────────────────
  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId/parts/search",
    { preHandler: [requireAuth, requireMember, requireWorkspace] },
    async (req, reply) => {
      const parsed = SearchPartsInput.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const nexar = await loadNexarOr503(req, reply);
      if (!nexar) return;
      try {
        return await components.searchParts(nexar, parsed.data);
      } catch (err) {
        reply.code(502);
        return { error: "upstream_error", detail: (err as Error).message };
      }
    }
  );

  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId/parts/availability",
    { preHandler: [requireAuth, requireMember, requireWorkspace] },
    async (req, reply) => {
      const parsed = CheckAvailabilityInput.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const nexar = await loadNexarOr503(req, reply);
      if (!nexar) return;
      try {
        return await components.checkPartAvailability(nexar, parsed.data);
      } catch (err) {
        reply.code(502);
        return { error: "upstream_error", detail: (err as Error).message };
      }
    }
  );

  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId/parts/alternatives",
    { preHandler: [requireAuth, requireMember, requireWorkspace] },
    async (req, reply) => {
      const parsed = FindAlternativePartsInput.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const nexar = await loadNexarOr503(req, reply);
      if (!nexar) return;
      try {
        return await components.findAlternativeParts(nexar, parsed.data);
      } catch (err) {
        reply.code(502);
        return { error: "upstream_error", detail: (err as Error).message };
      }
    }
  );

  // ── Library ──────────────────────────────────────────────────────────
  // The handler accepts an `altiumWorkspaceUrl` arg. The workspace's
  // own stored URL is the natural default; we let callers override
  // for the rare case of querying a different Altium 365 workspace
  // through the same Nexar credentials.
  const LibraryQuery = z.object({
    altiumWorkspaceUrl: z.string().url().optional(),
  });
  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId/library/components",
    { preHandler: [requireAuth, requireMember, requireWorkspace] },
    async (req, reply) => {
      const parsed = LibraryQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const url =
        parsed.data.altiumWorkspaceUrl ?? req.workspace?.altiumWorkspaceUrl;
      if (!url) {
        reply.code(400);
        return {
          error: "missing_altium_workspace_url",
          detail:
            "This workspace has no Altium 365 URL configured. Pass " +
            "altiumWorkspaceUrl in the query, or set it on the workspace.",
        };
      }
      const nexar = await loadNexarOr503(req, reply);
      if (!nexar) return;
      try {
        return await components.listLibraryComponents(nexar, {
          workspaceUrl: url,
        });
      } catch (err) {
        reply.code(502);
        return { error: "upstream_error", detail: (err as Error).message };
      }
    }
  );

  // ── Altium 365 (design.domain) ───────────────────────────────────────
  // The Nexar `desWorkspaces` query lists Altium 365 workspaces the
  // calling Nexar app has access to. Path makes the distinction clear
  // vs. PCBviber's own /api/orgs/:orgId/workspaces.
  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId/altium-365/workspaces",
    { preHandler: [requireAuth, requireMember, requireWorkspace] },
    async (req, reply) => {
      const nexar = await loadNexarOr503(req, reply);
      if (!nexar) return;
      try {
        return { workspaces: await projects.listWorkspaces(nexar) };
      } catch (err) {
        reply.code(502);
        return { error: "upstream_error", detail: (err as Error).message };
      }
    }
  );

  const Altium365ProjectsQuery = z.object({
    altiumWorkspaceUrl: z.string().url().optional(),
  });
  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId/altium-365/projects",
    { preHandler: [requireAuth, requireMember, requireWorkspace] },
    async (req, reply) => {
      const parsed = Altium365ProjectsQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const url =
        parsed.data.altiumWorkspaceUrl ?? req.workspace?.altiumWorkspaceUrl;
      if (!url) {
        reply.code(400);
        return {
          error: "missing_altium_workspace_url",
          detail:
            "This workspace has no Altium 365 URL configured. Pass " +
            "altiumWorkspaceUrl in the query, or set it on the workspace.",
        };
      }
      const nexar = await loadNexarOr503(req, reply);
      if (!nexar) return;
      try {
        return {
          projects: await projects.listProjects(nexar, { workspaceUrl: url }),
        };
      } catch (err) {
        reply.code(502);
        return { error: "upstream_error", detail: (err as Error).message };
      }
    }
  );
}
