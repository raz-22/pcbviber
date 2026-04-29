/**
 * Sprint 13 PR 13.1: in-memory artifact store for manufacturing
 * exports (Gerbers, drill files, BOM CSVs, pick-and-place CSVs).
 *
 * EasyEDA's `pcb_ManufactureData.getGerberFile()` returns a
 * browser File object that the extension uploads here via
 * `eda.sys_ClientUrl.request(API_BASE + '/artifacts', 'POST', file)`.
 * The server stores the bytes and returns an artifact ID.
 *
 * Altium's OutJob runner writes files to disk; the AD relay reads
 * them back as bytes and uploads through this same store from
 * server-side. Either way, the AI client never sees the file
 * content — it gets metadata + a `pcbviber://artifact/{id}` URL
 * that downstream tools can reference.
 *
 * v1 limitations:
 *   - In-memory only. Lost on server restart. Capped by process RAM.
 *     Production wants S3 / Postgres bytea — separate migration.
 *   - 1-hour default TTL. Configurable per-record but the only
 *     caller today uses the default.
 *   - Org-scoped retrieval: artifact ID is opaque (UUID); only the
 *     org that created it can download. No cross-org sharing in v1.
 *   - Single eviction sweep on each insert — fine for v1's
 *     low-throughput export workflow.
 */

import { randomUUID } from "node:crypto";

/** Cap a single artifact at 50 MB. Real-world Gerber zips are
 *  typically 1-5 MB; 50 MB covers BOM exports for huge boards
 *  without leaving a path for accidental memory blowup. */
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export type ArtifactFormat =
  | "gerber-zip"
  | "excellon-drill"
  | "csv-bom"
  | "csv-pick-and-place";

interface ArtifactRecord {
  id: string;
  orgId: string;
  format: ArtifactFormat;
  bytes: Buffer;
  mimeType: string;
  filename: string;
  createdAt: Date;
  expiresAt: Date;
  /** Format-specific metadata for AI clients without downloading. */
  meta: Record<string, unknown>;
}

export interface PutArtifactInput {
  orgId: string;
  format: ArtifactFormat;
  bytes: Buffer;
  mimeType: string;
  filename: string;
  ttlMs?: number;
  meta?: Record<string, unknown>;
}

export interface ArtifactSummary {
  id: string;
  format: ArtifactFormat;
  byteSize: number;
  mimeType: string;
  filename: string;
  createdAt: Date;
  expiresAt: Date;
  meta: Record<string, unknown>;
}

/**
 * In-memory artifact store. One instance per server process; the
 * caller (HTTP routes / platform impls) shares the singleton via
 * module-level export `artifactStore`.
 *
 * Evicts on each `put`: scans for expired records and drops them.
 * Cheap because v1's export traffic is low-throughput (a customer
 * runs maybe 10 exports/day, not thousands).
 */
export class ArtifactStore {
  private records = new Map<string, ArtifactRecord>();

  /**
   * Store new bytes; returns the assigned ID. Throws when bytes
   * exceed MAX_ARTIFACT_BYTES — caller surfaces as a clear error
   * rather than silently truncating.
   */
  put(input: PutArtifactInput): ArtifactSummary {
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact exceeds ${MAX_ARTIFACT_BYTES} byte cap (${input.bytes.byteLength} bytes). ` +
          `If you genuinely need this size, contact PCBviber to enable larger artifacts on your org.`
      );
    }
    this.evictExpired();
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));
    const record: ArtifactRecord = {
      id,
      orgId: input.orgId,
      format: input.format,
      bytes: input.bytes,
      mimeType: input.mimeType,
      filename: input.filename,
      createdAt: now,
      expiresAt,
      meta: input.meta ?? {},
    };
    this.records.set(id, record);
    return toSummary(record);
  }

  /**
   * Fetch an artifact for download. Returns null when:
   *   - the ID doesn't exist (404 to caller)
   *   - the record has expired (404 — same as not-found from
   *     the client's perspective; we don't leak existence)
   *   - the requesting org doesn't match the creating org
   *     (404, NOT 403 — preventing org enumeration)
   */
  get(id: string, requestingOrgId: string): ArtifactRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.expiresAt.getTime() <= Date.now()) {
      this.records.delete(id);
      return null;
    }
    if (record.orgId !== requestingOrgId) return null;
    return record;
  }

  /** Number of live (non-expired) records — used by tests. */
  size(): number {
    this.evictExpired();
    return this.records.size;
  }

  /** Drop all records — used by tests to reset state. */
  clear(): void {
    this.records.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt.getTime() <= now) {
        this.records.delete(id);
      }
    }
  }
}

function toSummary(record: ArtifactRecord): ArtifactSummary {
  return {
    id: record.id,
    format: record.format,
    byteSize: record.bytes.byteLength,
    mimeType: record.mimeType,
    filename: record.filename,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    meta: record.meta,
  };
}

/** Process-singleton. Module-level so all callers share state. */
export const artifactStore = new ArtifactStore();
