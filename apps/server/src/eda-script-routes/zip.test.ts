/**
 * `buildZip` contract tests — Sprint 9 PR 9.5a.
 *
 * The zip writer is purpose-built for the .eext use case (small,
 * 3 files, ASCII names, store-only). Tests pin the bytes downstream
 * unzippers depend on:
 *
 *   - File data round-trips: extract via Node's built-in unzipping
 *     (we don't have it, so we manually parse the central directory
 *     instead) and confirm names + content match what was packed.
 *   - Magic bytes appear at the right offsets: local file header,
 *     central directory, end-of-central-directory.
 *   - CRC32 column matches the actual file content's checksum so a
 *     downstream unzipper that validates won't reject the archive.
 *   - Single-file empty-content edge case (.eext could in principle
 *     have a 0-byte file; the zip format handles it; we pin it).
 *
 * No external dep — we read the bytes directly. If a future change
 * shifts header layout, these tests fail loud rather than waiting
 * for an EasyEDA installer to refuse the .eext at runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "./zip.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

test("buildZip: empty input produces a valid empty archive (just EOCD)", () => {
  const zip = buildZip([]);
  // 22 bytes for the EOCD; nothing else.
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), SIG_EOCD);
  assert.equal(zip.readUInt16LE(8), 0); // entries on disk
  assert.equal(zip.readUInt16LE(10), 0); // entries total
});

test("buildZip: single file — local header + central dir + EOCD all present in order", () => {
  const content = Buffer.from("hello world", "utf8");
  const zip = buildZip([{ name: "hello.txt", content: new Uint8Array(content) }]);

  // First 4 bytes: local file header signature.
  assert.equal(zip.readUInt32LE(0), SIG_LOCAL);

  // EOCD lives in the last 22 bytes (no comment).
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), SIG_EOCD);

  // Number of entries: 1.
  assert.equal(zip.readUInt16LE(eocdOffset + 8), 1);
  assert.equal(zip.readUInt16LE(eocdOffset + 10), 1);

  // Central directory offset (16 bytes into EOCD) points at
  // SIG_CENTRAL.
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  assert.equal(zip.readUInt32LE(centralOffset), SIG_CENTRAL);
});

test("buildZip: file content round-trips byte-for-byte through the local header", () => {
  // Manually pull the file content out of the local header slot.
  // Layout: [30-byte fixed][name][content].
  const expected = Buffer.from("here be bytes\nover multiple lines.", "utf8");
  const zip = buildZip([
    { name: "data.txt", content: new Uint8Array(expected) },
  ]);
  const nameLen = zip.readUInt16LE(26);
  const contentLen = zip.readUInt32LE(22); // uncompressed size (== compressed for store)
  assert.equal(nameLen, "data.txt".length);
  assert.equal(contentLen, expected.length);
  const contentStart = 30 + nameLen;
  const actual = zip.subarray(contentStart, contentStart + contentLen);
  assert.deepEqual(actual, expected);
});

test("buildZip: CRC32 matches the actual content for non-trivial data", () => {
  // The CRC32 in the local header must match the actual file
  // content; otherwise EasyEDA's unzipper rejects the archive.
  // Cross-check against a known CRC32 vector — "abcdefghijklmnopqrstuvwxyz"
  // has CRC32 0x4c2750bd per the ZIP spec's usual reference.
  const content = Buffer.from("abcdefghijklmnopqrstuvwxyz", "utf8");
  const zip = buildZip([{ name: "az.txt", content: new Uint8Array(content) }]);
  // CRC32 lives at offset 14 in the local file header.
  assert.equal(zip.readUInt32LE(14), 0x4c2750bd);
});

test("buildZip: multi-file archive — file count + offset chain are consistent", () => {
  const entries = [
    { name: "a.txt", content: new Uint8Array(Buffer.from("a", "utf8")) },
    { name: "b/c.txt", content: new Uint8Array(Buffer.from("bc", "utf8")) },
    { name: "d/e/f.txt", content: new Uint8Array(Buffer.from("def!", "utf8")) },
  ];
  const zip = buildZip(entries);

  // Walk local headers by their "next offset" (header size + name + content),
  // confirm each magic + parse names back.
  const seenNames: string[] = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    assert.equal(zip.readUInt32LE(offset), SIG_LOCAL, `entry ${i} local sig`);
    const nameLen = zip.readUInt16LE(offset + 26);
    const contentLen = zip.readUInt32LE(offset + 22);
    const name = zip
      .subarray(offset + 30, offset + 30 + nameLen)
      .toString("utf8");
    seenNames.push(name);
    offset += 30 + nameLen + contentLen;
  }
  assert.deepEqual(seenNames, ["a.txt", "b/c.txt", "d/e/f.txt"]);

  // EOCD entry count agrees.
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt16LE(eocdOffset + 10), 3);
});

test("buildZip: zero-byte content — size and CRC fields are zeroed; archive is still valid", () => {
  // Edge case: an entry with empty content. A defensible .eext could
  // include a 0-byte placeholder (e.g. a CHANGELOG that hasn't been
  // written yet). Pin the corner so the writer doesn't off-by-one.
  const zip = buildZip([{ name: "empty.txt", content: new Uint8Array(0) }]);
  assert.equal(zip.readUInt32LE(0), SIG_LOCAL);
  assert.equal(zip.readUInt32LE(14), 0); // CRC32 of empty input is 0
  assert.equal(zip.readUInt32LE(18), 0); // compressed size
  assert.equal(zip.readUInt32LE(22), 0); // uncompressed size
});
