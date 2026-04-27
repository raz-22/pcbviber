/**
 * Minimal pure-Node ZIP writer (store-only, no compression).
 *
 * Built to pack the EasyEDA Pro extension into a `.eext` archive
 * without pulling in `archiver` / `jszip` / `adm-zip` as runtime
 * deps. The extension package is ~10 KB across three files; gains
 * from compression are negligible at that size, and the ZIP "store"
 * format is small enough to implement honestly in <100 lines.
 *
 * Format spec: PKWARE APPNOTE.TXT, sections 4.3.7 (local file
 * header), 4.3.12 (central directory), 4.3.16 (end of central
 * directory record).
 *
 * Limitations (intentional, all acceptable for this use):
 *   - Store-only, no DEFLATE — the extension is text + JSON.
 *   - No directory entries, just files (EasyEDA finds `src/`
 *     entries by their forward-slash paths in the archive).
 *   - No timestamp encoding — every file gets MS-DOS epoch 0.
 *     The extension's freshness tracking lives in `version` in
 *     extension.json, not file mtimes.
 *   - No UTF-8 flag — file paths are ASCII-only so `1252` and
 *     UTF-8 read identically. If we ever ship a non-ASCII file
 *     name, set bit 11 of the general-purpose flags.
 */

interface ZipEntry {
  /** Forward-slash path inside the archive (e.g. "src/index.js"). */
  name: string;
  /** Raw bytes of the file. */
  content: Uint8Array;
}

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_EOCD = 0x06054b50;
const VERSION = 20; // 2.0 — minimum for store

// CRC32 table (PKZIP polynomial 0xedb88320). Computed once at
// module load — cheap, ~1 KB of memory.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pack the given entries into a single store-only ZIP buffer. The
 * returned Buffer is a complete .zip / .eext file, ready to write
 * to disk or stream to an HTTP response.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content);
    const crc = crc32(content);

    // Local file header (30-byte fixed + name + content).
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(SIGNATURE_LOCAL, 0);
    localHeader.writeUInt16LE(VERSION, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression: store
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18); // compressed size
    localHeader.writeUInt32LE(content.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    const localChunk = Buffer.concat([localHeader, nameBuf, content]);
    localChunks.push(localChunk);

    // Central directory entry (46-byte fixed + name).
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(SIGNATURE_CENTRAL, 0);
    centralHeader.writeUInt16LE(VERSION, 4); // version made by
    centralHeader.writeUInt16LE(VERSION, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    centralChunks.push(Buffer.concat([centralHeader, nameBuf]));

    offset += localChunk.length;
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);

  // End-of-central-directory record (22 bytes, no comment).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIGNATURE_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, centralPart, eocd]);
}
