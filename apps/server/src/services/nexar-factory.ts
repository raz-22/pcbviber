/**
 * NexarServiceFactory — per-workspace NexarService loader with caching.
 *
 * Per the internal design spec §5.1:
 *   "NexarService constructor takes { clientId, clientSecret }. A
 *   `NexarServiceFactory.forWorkspace(workspaceId)` loads encrypted
 *   creds, decrypts, caches the instance per-workspace in an LRU
 *   (max 500 entries, TTL 15 min)."
 *
 * Sprint 2 introduces this factory. PR 2.3 cuts the existing
 * Nexar-using handlers over to `factory.forWorkspace(ctx.workspaceId)`
 * instead of consuming the singleton from env. The env-based instance
 * stays around as a dev fallback until that cutover.
 *
 * The cache is a small hand-rolled LRU keyed by workspaceId. Picking
 * a Map-with-eviction over a heavyweight LRU package keeps the code
 * footprint small and easy to reason about; perf isn't a constraint
 * at the scale we'll see in the first sprints.
 */

import { decryptCredential } from "@altium-mcp/db";
import { withTenantTx } from "../db/tenant-tx.js";
import { NexarService } from "./nexar.js";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min

interface CacheEntry {
  service: NexarService;
  /**
   * orgId the cached entry was loaded for. Validated on hit so a
   * programmer-error call site that passes the wrong orgId can't
   * silently get a service for a workspace that belongs to another
   * tenant. The route layer's `requireWorkspace` middleware would
   * normally catch this earlier (RLS hides cross-tenant workspaces
   * during its lookup), but we don't rely on call-site discipline
   * for a cache that survives 15 minutes.
   */
  orgId: string;
  expiresAt: number;
}

export class NexarServiceFactory {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Pre-storage credential test. Pure pass-through to
   * NexarService.checkCredentials — kept here so callers don't have to
   * import both the factory and the service.
   */
  async testCredentials(
    clientId: string,
    clientSecret: string
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    return NexarService.checkCredentials(clientId, clientSecret);
  }

  /**
   * Returns a NexarService bound to the given workspace's stored
   * (decrypted-in-memory) credentials. Throws if the workspace is
   * missing creds or the credentials can't be decrypted.
   *
   * The factory's job is to keep the decrypted secret in memory only
   * for the lifetime of the cache entry; nothing else outside this
   * file should ever need to call decryptCredential().
   *
   * `orgId` is required so the encrypted-creds read can run inside
   * a tenant-scoped transaction. RLS on Workspace then filters by
   * `orgId = current_setting('app.current_org_id')`, so a
   * workspaceId from a different org returns null even if the cache
   * happened to be cold and the row exists. Defense in depth on the
   * highest-value secret in the system (decrypted Nexar creds).
   */
  async forWorkspace(
    workspaceId: string,
    orgId: string
  ): Promise<NexarService> {
    const cached = this.cache.get(workspaceId);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.orgId === orgId
    ) {
      // LRU bump: re-insert to push to end of iteration order.
      this.cache.delete(workspaceId);
      this.cache.set(workspaceId, cached);
      return cached.service;
    }
    // Cache miss OR orgId mismatch — fall through to a fresh read.
    // A mismatch means a buggy caller passed the wrong orgId; the
    // tenant-bounded read below will return null + we'll throw
    // "not found", same as if the workspace didn't exist.

    const ws = await withTenantTx(orgId, (tx) =>
      tx.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          nexarClientIdEnc: true,
          nexarClientSecretEnc: true,
        },
      })
    );
    if (!ws) {
      throw new Error(`workspace ${workspaceId} not found`);
    }
    if (!ws.nexarClientIdEnc || !ws.nexarClientSecretEnc) {
      throw new Error(
        `workspace ${workspaceId} has no Nexar credentials configured`
      );
    }

    let clientId: string;
    let clientSecret: string;
    try {
      clientId = decryptCredential(ws.nexarClientIdEnc);
      clientSecret = decryptCredential(ws.nexarClientSecretEnc);
    } catch (err) {
      throw new Error(
        `failed to decrypt workspace ${workspaceId} credentials: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const service = new NexarService({
      nexarClientId: clientId,
      nexarClientSecret: clientSecret,
    });

    this.put(workspaceId, orgId, service);
    return service;
  }

  /**
   * Drop a workspace from the cache. Call after the workspace's creds
   * change (PATCH endpoint) so the next forWorkspace() picks up the
   * new creds. Idempotent.
   */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  /** Drop everything. Used on shutdown / for tests. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private put(workspaceId: string, orgId: string, service: NexarService): void {
    if (this.cache.size >= this.maxEntries) {
      // Evict the oldest entry (insertion order = age, oldest first).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(workspaceId, {
      service,
      orgId,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** For tests only. Returns the current size of the cache. */
  __sizeForTests(): number {
    return this.cache.size;
  }
}
