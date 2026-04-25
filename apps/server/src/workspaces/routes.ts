/**
 * /api/orgs/:orgId/workspaces/* — Workspace CRUD.
 *
 * Per the internal design spec §3.3:
 *   "GET/POST/DELETE /api/orgs/:id/workspaces — Settings → Workspaces.
 *   Paste Altium URL + Nexar creds; test button calls Nexar once and
 *   stores encrypted only if 200 OK."
 *
 * Sprint 2 PR 2.2.
 *
 * Authorization:
 *   - List + read: any member
 *   - Create / update / delete / test: owner or admin
 *   - billing_only role: cannot use any workspace endpoint (per §3.4)
 *
 * Encryption: all Nexar / Altium tokens stored via `encryptCredential`
 * from @altium-mcp/db. They never leave this file decrypted; responses
 * include only metadata + a boolean `hasNexarCredentials`.
 *
 * Audit log: every mutation writes a row (workspace.add / .update /
 * .delete / .test_connection). Test-connection writes the audit
 * regardless of outcome — failed credential tests are interesting too.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, encryptCredential } from "@altium-mcp/db";
import { makeRequireAuth } from "../auth/middleware.js";
import { makeRequireOrgRole } from "../auth/tenant.js";
import { writeAuditLog, clientIp } from "../auth/audit.js";
import type { AuthProvider } from "@altium-mcp/auth";
import type { NexarServiceFactory } from "../services/nexar-factory.js";
import { csrfOrPassthrough } from "../security/csrf.js";

// ─── Input schemas ────────────────────────────────────────────────────

const CredsBody = z.object({
  nexarClientId: z.string().min(1).max(256),
  nexarClientSecret: z.string().min(1).max(512),
});

const TestConnectionBody = CredsBody;

const CreateWorkspaceBody = z.object({
  altiumWorkspaceUrl: z.string().url().max(512).optional(),
  nexarClientId: z.string().min(1).max(256),
  nexarClientSecret: z.string().min(1).max(512),
  altiumRestToken: z.string().min(1).max(2048).optional(),
  /**
   * If true (default), the server tests the credentials with Nexar
   * before persisting. On test failure, returns 422 + does not write
   * a row. Set to false to bypass — useful when seeding a workspace
   * for an org that's pre-paying for Nexar but doesn't have keys yet.
   */
  testBeforeStore: z.boolean().default(true),
});

const UpdateWorkspaceBody = z
  .object({
    altiumWorkspaceUrl: z.string().url().max(512).nullable().optional(),
    nexarClientId: z.string().min(1).max(256).optional(),
    nexarClientSecret: z.string().min(1).max(512).optional(),
    altiumRestToken: z.string().min(1).max(2048).nullable().optional(),
    testBeforeStore: z.boolean().default(true),
  })
  .refine(
    (v) =>
      // If only one of clientId/clientSecret is supplied, the test will
      // either re-test against half-new + half-old creds (confusing) or
      // we'd silently drop one. Require both or neither.
      (v.nexarClientId === undefined) === (v.nexarClientSecret === undefined),
    { message: "nexarClientId and nexarClientSecret must be provided together" }
  );

// ─── Registration ─────────────────────────────────────────────────────

export interface WorkspaceRouteDeps {
  /** Lets tests inject a stub factory; production uses the real one. */
  nexarFactory: NexarServiceFactory;
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  deps: WorkspaceRouteDeps
): Promise<void> {
  const requireAuth = makeRequireAuth(auth);
  const requireMember = makeRequireOrgRole([]);
  const requireAdmin = makeRequireOrgRole(["owner", "admin"]);
  const { nexarFactory } = deps;

  // ── Test connection (no row created, no row updated) ────────────────
  app.post(
    "/api/orgs/:orgId/workspaces/test-connection",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin] },
    async (req, reply) => {
      const parsed = TestConnectionBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const result = await nexarFactory.testCredentials(
        parsed.data.nexarClientId,
        parsed.data.nexarClientSecret
      );

      // Audit either way — failed credential tests are signal too.
      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "workspace.test_connection",
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { ok: result.ok, status: "status" in result ? result.status : 200 },
      });

      if (result.ok) return { ok: true };
      reply.code(422);
      return { ok: false, error: result.error, status: result.status };
    }
  );

  // ── List workspaces ─────────────────────────────────────────────────
  app.get(
    "/api/orgs/:orgId/workspaces",
    { preHandler: [requireAuth, requireMember] },
    async (req) => {
      const ctx = req.ctx!;
      const rows = await prisma.workspace.findMany({
        where: { orgId: ctx.org.id },
        orderBy: { createdAt: "asc" },
      });
      return { workspaces: rows.map(serializeWorkspace) };
    }
  );

  // ── Get a single workspace ──────────────────────────────────────────
  app.get(
    "/api/orgs/:orgId/workspaces/:workspaceId",
    { preHandler: [requireAuth, requireMember] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { workspaceId } = req.params as { workspaceId: string };
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!ws || ws.orgId !== ctx.org.id) {
        // Same defense as cross-tenant: collapse "no such workspace"
        // and "not yours" into 404 to prevent enumeration.
        reply.code(404);
        return { error: "not_found" };
      }
      return { workspace: serializeWorkspace(ws) };
    }
  );

  // ── Create ──────────────────────────────────────────────────────────
  app.post(
    "/api/orgs/:orgId/workspaces",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin] },
    async (req, reply) => {
      const parsed = CreateWorkspaceBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const data = parsed.data;

      if (data.testBeforeStore) {
        const test = await nexarFactory.testCredentials(
          data.nexarClientId,
          data.nexarClientSecret
        );
        if (!test.ok) {
          await writeAuditLog({
            orgId: ctx.org.id,
            actorUserId: ctx.user.id,
            action: "workspace.test_connection",
            ip: clientIp(req),
            userAgent: req.headers["user-agent"],
            metadata: { ok: false, phase: "create", status: test.status },
          });
          reply.code(422);
          return {
            error: "credentials_rejected",
            detail: test.error,
            status: test.status,
          };
        }
      }

      const ws = await prisma.workspace.create({
        data: {
          orgId: ctx.org.id,
          altiumWorkspaceUrl: data.altiumWorkspaceUrl ?? null,
          nexarClientIdEnc: encryptCredential(data.nexarClientId),
          nexarClientSecretEnc: encryptCredential(data.nexarClientSecret),
          altiumRestTokenEnc: data.altiumRestToken
            ? encryptCredential(data.altiumRestToken)
            : null,
        },
      });

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "workspace.add",
        target: ws.id,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { altiumWorkspaceUrl: ws.altiumWorkspaceUrl ?? null },
      });

      reply.code(201);
      return { workspace: serializeWorkspace(ws) };
    }
  );

  // ── Update ──────────────────────────────────────────────────────────
  app.patch(
    "/api/orgs/:orgId/workspaces/:workspaceId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin] },
    async (req, reply) => {
      const parsed = UpdateWorkspaceBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_input", detail: parsed.error.flatten() };
      }
      const ctx = req.ctx!;
      const { workspaceId } = req.params as { workspaceId: string };
      const data = parsed.data;

      const existing = await prisma.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!existing || existing.orgId !== ctx.org.id) {
        reply.code(404);
        return { error: "not_found" };
      }

      // Re-test creds if both fields supplied.
      if (
        data.testBeforeStore &&
        data.nexarClientId !== undefined &&
        data.nexarClientSecret !== undefined
      ) {
        const test = await nexarFactory.testCredentials(
          data.nexarClientId,
          data.nexarClientSecret
        );
        if (!test.ok) {
          await writeAuditLog({
            orgId: ctx.org.id,
            actorUserId: ctx.user.id,
            action: "workspace.test_connection",
            target: workspaceId,
            ip: clientIp(req),
            userAgent: req.headers["user-agent"],
            metadata: { ok: false, phase: "update", status: test.status },
          });
          reply.code(422);
          return {
            error: "credentials_rejected",
            detail: test.error,
            status: test.status,
          };
        }
      }

      const update: Record<string, unknown> = {};
      if (data.altiumWorkspaceUrl !== undefined) {
        update.altiumWorkspaceUrl = data.altiumWorkspaceUrl;
      }
      if (data.nexarClientId !== undefined && data.nexarClientSecret !== undefined) {
        update.nexarClientIdEnc = encryptCredential(data.nexarClientId);
        update.nexarClientSecretEnc = encryptCredential(data.nexarClientSecret);
      }
      if (data.altiumRestToken !== undefined) {
        update.altiumRestTokenEnc =
          data.altiumRestToken === null
            ? null
            : encryptCredential(data.altiumRestToken);
      }

      const ws = await prisma.workspace.update({
        where: { id: workspaceId },
        data: update,
      });

      // Drop the cache so the next forWorkspace() picks up new creds.
      nexarFactory.invalidate(workspaceId);

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "workspace.update",
        target: workspaceId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: {
          fields: Object.keys(update),
        },
      });

      return { workspace: serializeWorkspace(ws) };
    }
  );

  // ── Delete ──────────────────────────────────────────────────────────
  app.delete(
    "/api/orgs/:orgId/workspaces/:workspaceId",
    { preHandler: [csrfOrPassthrough(app), requireAuth, requireAdmin] },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { workspaceId } = req.params as { workspaceId: string };

      const existing = await prisma.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!existing || existing.orgId !== ctx.org.id) {
        reply.code(404);
        return { error: "not_found" };
      }

      await prisma.workspace.delete({ where: { id: workspaceId } });
      nexarFactory.invalidate(workspaceId);

      await writeAuditLog({
        orgId: ctx.org.id,
        actorUserId: ctx.user.id,
        action: "workspace.delete",
        target: workspaceId,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"],
        metadata: { altiumWorkspaceUrl: existing.altiumWorkspaceUrl ?? null },
      });

      return { ok: true };
    }
  );
}

// ─── Response shape ───────────────────────────────────────────────────
//
// Public Workspace shape — never includes ciphertext or anything that
// would help an attacker. `hasNexarCredentials` is exposed so the SPA
// can render "configured" vs "needs setup" without round-tripping.

function serializeWorkspace(ws: {
  id: string;
  orgId: string;
  altiumWorkspaceUrl: string | null;
  nexarClientIdEnc: string | null;
  nexarClientSecretEnc: string | null;
  altiumRestTokenEnc: string | null;
  createdAt: Date;
}) {
  return {
    id: ws.id,
    orgId: ws.orgId,
    altiumWorkspaceUrl: ws.altiumWorkspaceUrl,
    hasNexarCredentials: !!(ws.nexarClientIdEnc && ws.nexarClientSecretEnc),
    hasAltiumRestToken: !!ws.altiumRestTokenEnc,
    createdAt: ws.createdAt.toISOString(),
  };
}
