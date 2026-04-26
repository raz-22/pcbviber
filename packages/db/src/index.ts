/**
 * Database client for the Altium-MCP SaaS.
 *
 * Exports a lazy singleton PrismaClient plus the encryption helpers
 * used to protect tenant-scoped credentials at rest. See package
 * README for setup (DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY).
 *
 * Lazy construction: PrismaClient resolves `env("DATABASE_URL")`
 * at construction time. If we built the client at module-import
 * time, every test file that statically imports something from this
 * package (directly or transitively) would lock in whatever
 * DATABASE_URL was at that exact moment — usually unset. We hide
 * the singleton behind a Proxy so the real client is constructed
 * on the first property access, after `setupTestDatabase()` /
 * dotenv / etc. have populated the env.
 */

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient__: PrismaClient | undefined;
}

function pickLogLevels(): ("query" | "info" | "warn" | "error")[] {
  // Dev surfaces queries so slow paths are obvious; prod and test stay
  // quiet (prod avoids PII in logs; test output stays readable).
  switch (process.env.NODE_ENV) {
    case "production":
    case "test":
      return ["warn", "error"];
    default:
      return ["warn", "error", "query"];
  }
}

function makeClient(): PrismaClient {
  // A single PrismaClient per Node process. In dev with tsx-watch /
  // tsc --watch, module reloads would otherwise leak connections;
  // the global cache bounds that.
  if (!globalThis.__prismaClient__) {
    globalThis.__prismaClient__ = new PrismaClient({ log: pickLogLevels() });
  }
  return globalThis.__prismaClient__;
}

let cachedClient: PrismaClient | null = null;

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!cachedClient) cachedClient = makeClient();
    const value = Reflect.get(cachedClient, prop, cachedClient);
    return typeof value === "function" ? value.bind(cachedClient) : value;
  },
}) as PrismaClient;

export * from "@prisma/client";
export * from "./encryption.js";
