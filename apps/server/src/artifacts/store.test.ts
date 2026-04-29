/**
 * Sprint 13 PR 13.1: artifact-store tests. Pure-logic tests
 * against the in-memory store; HTTP-route tests live with the
 * route file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ArtifactStore, DEFAULT_TTL_MS } from "./store.js";

function makeBytes(size: number): Buffer {
  return Buffer.alloc(size, 0xab);
}

test("ArtifactStore.put + get: round-trips for the creating org", () => {
  const store = new ArtifactStore();
  const summary = store.put({
    orgId: "org-1",
    format: "gerber-zip",
    bytes: makeBytes(1024),
    mimeType: "application/zip",
    filename: "Gerber.zip",
  });
  assert.equal(summary.byteSize, 1024);
  assert.equal(summary.format, "gerber-zip");
  // Retrieval as the creating org succeeds + returns the bytes.
  const record = store.get(summary.id, "org-1");
  assert.ok(record !== null);
  if (record) {
    assert.equal(record.bytes.byteLength, 1024);
    assert.equal(record.format, "gerber-zip");
  }
});

test("ArtifactStore.get: returns null for unknown id (404, no leakage)", () => {
  const store = new ArtifactStore();
  assert.equal(store.get("not-a-real-id", "org-1"), null);
});

test("ArtifactStore.get: cross-org retrieval returns null (404, NOT 403 — no enumeration)", () => {
  // Pin the architectural contract: a different org seeing the
  // artifact ID can't tell it from a non-existent one. Returning
  // 403 would let attackers enumerate by ID.
  const store = new ArtifactStore();
  const summary = store.put({
    orgId: "org-1",
    format: "csv-bom",
    bytes: makeBytes(100),
    mimeType: "text/csv",
    filename: "bom.csv",
  });
  assert.equal(
    store.get(summary.id, "org-2"),
    null,
    "cross-org retrieval must return null, not throw or 403"
  );
});

test("ArtifactStore.get: expired records evicted + null returned", () => {
  // Pin the TTL eviction. Use ttlMs:0 to expire immediately;
  // get() must return null AND drop the record from the map.
  const store = new ArtifactStore();
  const summary = store.put({
    orgId: "org-1",
    format: "excellon-drill",
    bytes: makeBytes(100),
    mimeType: "application/octet-stream",
    filename: "drill.drl",
    ttlMs: 0,
  });
  // 0ms TTL: any get() after the put completes should be expired.
  const result = store.get(summary.id, "org-1");
  assert.equal(result, null, "expired artifact must return null");
  assert.equal(store.size(), 0, "expired artifact must be evicted");
});

test("ArtifactStore.put: oversized bytes rejected with actionable error", () => {
  // 51 MB exceeds the 50 MB cap; throws cleanly so callers can
  // pass the message to AI clients verbatim.
  const store = new ArtifactStore();
  assert.throws(
    () =>
      store.put({
        orgId: "org-1",
        format: "gerber-zip",
        bytes: makeBytes(51 * 1024 * 1024),
        mimeType: "application/zip",
        filename: "huge.zip",
      }),
    /exceeds 52428800 byte cap/
  );
});

test("ArtifactStore: default TTL is 1 hour", () => {
  // Pin the constant so a future PR can't silently change it.
  // Tooling/docs reference 1h.
  const oneHour = 60 * 60 * 1000;
  assert.equal(DEFAULT_TTL_MS, oneHour);
});

test("ArtifactStore.put: insertion sweeps expired records (eviction without explicit call)", () => {
  // Insertion N+1 should reap expired entries from N. Pin that
  // the store doesn't grow unboundedly when callers create
  // many short-lived artifacts.
  const store = new ArtifactStore();
  store.put({
    orgId: "org-1",
    format: "csv-bom",
    bytes: makeBytes(10),
    mimeType: "text/csv",
    filename: "expire.csv",
    ttlMs: 0,
  });
  // First record is now expired but still in the map until next
  // put or get triggers eviction.
  store.put({
    orgId: "org-1",
    format: "csv-bom",
    bytes: makeBytes(20),
    mimeType: "text/csv",
    filename: "fresh.csv",
  });
  // After the second put, the first record is gone.
  assert.equal(store.size(), 1);
});

test("ArtifactStore.get: meta payload round-trips verbatim", () => {
  // Format-specific metadata (layer count for gerbers, line count
  // for csv) needs to survive the put-get round-trip so AI clients
  // can read it without downloading.
  const store = new ArtifactStore();
  const summary = store.put({
    orgId: "org-1",
    format: "gerber-zip",
    bytes: makeBytes(100),
    mimeType: "application/zip",
    filename: "g.zip",
    meta: { layers: 6, fileCount: 14, project: "PSU-v3" },
  });
  assert.deepEqual(summary.meta, { layers: 6, fileCount: 14, project: "PSU-v3" });
  const record = store.get(summary.id, "org-1");
  if (record) {
    assert.deepEqual(record.meta, {
      layers: 6,
      fileCount: 14,
      project: "PSU-v3",
    });
  }
});
