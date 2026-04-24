/**
 * Database client for the Altium-MCP SaaS.
 *
 * Exports a singleton PrismaClient plus the encryption helpers used to
 * protect tenant-scoped credentials at rest. See package README for
 * setup (DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY).
 */

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient__: PrismaClient | undefined;
}

/**
 * A single PrismaClient per Node process. In dev with tsx-watch / tsc
 * --watch, module reloads would otherwise leak connections; the global
 * cache bounds that.
 */
export const prisma: PrismaClient =
  globalThis.__prismaClient__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prismaClient__ = prisma;
}

export * from "@prisma/client";
export * from "./encryption.js";
