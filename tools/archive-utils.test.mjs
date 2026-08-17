import assert from "node:assert/strict";
import { deflateRawSync, gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createArchive,
  extractArchive,
  inventoryBinaries,
  TAR_EXTRACTION_LIMITS,
  ZIP_EXTRACTION_LIMITS,
} from "./archive-utils.mjs";

const ZIP_UTF8_FLAG = 0x0800;

function writeTarOctal(header, value, offset, length) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, "ascii");
}

function tarHeader({ name, size = 0, type = "0", mode = 0o644 }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  writeTarOctal(header, mode, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function tarFixture(entries, { eofBlocks = 2, trailing = Buffer.alloc(0) } = {}) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const size = entry.size ?? content.length;
    const header = tarHeader({ ...entry, size });
    if (entry.corruptChecksum) header[148] ^= 1;
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, entry.paddingByte ?? 0));
  }
  chunks.push(Buffer.alloc(eofBlocks * 512), trailing);
  return Buffer.concat(chunks);
}

function assertTarRejected(root, tar, pattern) {
  const archive = path.join(root, "invalid.tar.gz");
  const destination = path.join(root, "out");
  writeFileSync(archive, gzipSync(tar, { level: 0 }));
  assert.throws(() => extractArchive(archive, destination, "darwin"), pattern);
  assert.equal(existsSync(destination), false, "a rejected archive leaves no partial extraction");
}

function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipFixture(entries, { count = entries.length } = {}) {
  const locals = [];
  const descriptors = [];
  let localOffset = 0;
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "content");
    const method = entry.method ?? 0;
    const compressed =
      entry.compressed === undefined
        ? method === 8
          ? deflateRawSync(content)
          : content
        : Buffer.from(entry.compressed);
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const flags = entry.flags ?? ZIP_UTF8_FLAG;
    const crc = entry.checksum ?? checksum(content);
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? content.length;
    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.localFlags ?? flags, 6);
    local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt32LE(entry.localChecksum ?? crc, 14);
    local.writeUInt32LE(entry.localCompressedSize ?? compressedSize, 18);
    local.writeUInt32LE(entry.localUncompressedSize ?? uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    localName.copy(local, 30);
    locals.push(local, compressed);
    descriptors.push({
      compressedSize,
      crc,
      externalAttributes: entry.externalAttributes ?? ((0o100000 | 0o644) << 16) >>> 0,
      flags,
      localOffset,
      method,
      name,
      uncompressedSize,
    });
    localOffset += local.length + compressed.length;
  }

  const central = descriptors.map((entry) => {
    const header = Buffer.alloc(46 + entry.name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt32LE(entry.externalAttributes, 38);
    header.writeUInt32LE(entry.localOffset, 42);
    entry.name.copy(header, 46);
    return header;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function assertZipRejected(root, bytes, pattern) {
  const archive = path.join(root, "invalid.zip");
  const destination = path.join(root, "out");
  writeFileSync(archive, bytes);
  assert.throws(() => extractArchive(archive, destination, "win32"), pattern);
  assert.equal(existsSync(destination), false, "a rejected archive leaves no partial extraction");
}

function machoFixture() {
  return Buffer.from("cafebabe000000010000000000000000", "hex");
}

function peFixture() {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64, "ascii");
  return bytes;
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform} archive round-trips and inventories platform binaries`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "nexa-archive-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const extracted = path.join(root, "extracted");
    const archive = path.join(root, platform === "darwin" ? "app.tar.gz" : "app.zip");
    const nested = path.join(
      source,
      platform === "darwin" ? "Nexa.app/Contents/MacOS/NexaNotes" : "Nexa/NexaNotes.exe",
    );
    const bytes = platform === "darwin" ? machoFixture() : peFixture();
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, bytes);
    createArchive(source, archive, platform);
    extractArchive(archive, extracted, platform);
    assert.deepEqual(readFileSync(path.join(extracted, path.relative(source, nested))), bytes);
    assert.deepEqual(
      inventoryBinaries(extracted, platform).map(({ relative }) => relative),
      [path.relative(source, nested)],
    );
  });
}

test("tar extraction rejects traversal, links, and special-file entries", (t) => {
  const fixtures = [
    { label: "traversal", entry: { name: "../escape" }, pattern: /unsafe archive path/u },
    {
      label: "symlink",
      entry: { name: "Nexa/link", type: "2" },
      pattern: /unsupported tar entry type/u,
    },
    {
      label: "special",
      entry: { name: "Nexa/pipe", type: "6" },
      pattern: /unsupported tar entry type/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-tar-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertTarRejected(root, tarFixture([fixture.entry]), fixture.pattern);
  }
});

test("tar extraction verifies header checksums and numeric fields", (t) => {
  const fixtures = [
    {
      label: "checksum",
      tar: tarFixture([{ name: "Nexa/readme.txt", content: "content", corruptChecksum: true }]),
      pattern: /tar header checksum mismatch/u,
    },
    {
      label: "number",
      tar: (() => {
        const tar = tarFixture([{ name: "Nexa/readme.txt" }]);
        tar.write("0000000000x\0", 124, "ascii");
        const header = tar.subarray(0, 512);
        header.fill(32, 148, 156);
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
        return tar;
      })(),
      pattern: /invalid tar size/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-tar-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertTarRejected(root, fixture.tar, fixture.pattern);
  }
});

test("tar extraction rejects duplicate, case-insensitive, and file/directory conflicts", (t) => {
  const fixtures = [
    {
      label: "duplicate",
      entries: [{ name: "Nexa/app" }, { name: "Nexa/app" }],
      pattern: /duplicate tar path: Nexa\/app/u,
    },
    {
      label: "case",
      entries: [{ name: "Nexa/app" }, { name: "nexa/helper" }],
      pattern: /case-insensitive tar path collision: Nexa and nexa/u,
    },
    {
      label: "type",
      entries: [{ name: "Nexa" }, { name: "Nexa/app" }],
      pattern: /tar file\/directory path conflict: Nexa/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-tar-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertTarRejected(root, tarFixture(fixture.entries), fixture.pattern);
  }
});

test("tar extraction enforces entry, expanded-size, and compression-ratio budgets", (t) => {
  const entryRoot = mkdtempSync(path.join(tmpdir(), "nexa-tar-entries-"));
  t.after(() => rmSync(entryRoot, { recursive: true, force: true }));
  assertTarRejected(
    entryRoot,
    tarFixture(
      Array.from({ length: TAR_EXTRACTION_LIMITS.maxEntries + 1 }, (_, index) => ({
        name: `Nexa/file-${index}`,
      })),
    ),
    new RegExp(`tar entry count exceeds ${TAR_EXTRACTION_LIMITS.maxEntries}`, "u"),
  );

  const sizeRoot = mkdtempSync(path.join(tmpdir(), "nexa-tar-size-"));
  t.after(() => rmSync(sizeRoot, { recursive: true, force: true }));
  assertTarRejected(
    sizeRoot,
    tarFixture([
      { name: "Nexa/oversized.bin", size: TAR_EXTRACTION_LIMITS.maxUncompressedBytes + 1 },
    ]),
    /tar expanded size exceeds/u,
  );

  const ratioRoot = mkdtempSync(path.join(tmpdir(), "nexa-tar-ratio-"));
  t.after(() => rmSync(ratioRoot, { recursive: true, force: true }));
  const archive = path.join(ratioRoot, "invalid.tar.gz");
  const destination = path.join(ratioRoot, "out");
  writeFileSync(
    archive,
    gzipSync(tarFixture([{ name: "Nexa/repetitive.bin", content: Buffer.alloc(256 * 1024) }]), {
      level: 9,
    }),
  );
  assert.throws(
    () => extractArchive(archive, destination, "darwin"),
    new RegExp(`tar compression ratio exceeds ${TAR_EXTRACTION_LIMITS.maxCompressionRatio}`, "u"),
  );
  assert.equal(existsSync(destination), false);
});

test("tar extraction requires zero padding and two zero EOF blocks", (t) => {
  const fixtures = [
    {
      label: "padding",
      tar: tarFixture([{ name: "Nexa/readme.txt", content: "x", paddingByte: 1 }]),
      pattern: /non-zero tar entry padding/u,
    },
    {
      label: "eof",
      tar: tarFixture([{ name: "Nexa/readme.txt", content: "x" }], { eofBlocks: 1 }),
      pattern: /tar end-of-archive marker is missing/u,
    },
    {
      label: "trailing",
      tar: tarFixture([], { trailing: Buffer.alloc(512, 1) }),
      pattern: /non-zero bytes after tar end-of-archive marker/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-tar-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertTarRejected(root, fixture.tar, fixture.pattern);
  }
});

test("darwin archive creation stores highly repetitive input within the extraction ratio budget", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-tar-create-ratio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.tar.gz");
  const destination = path.join(root, "out");
  mkdirSync(path.join(source, "Nexa.app"), { recursive: true });
  writeFileSync(path.join(source, "Nexa.app", "repetitive.bin"), Buffer.alloc(256 * 1024));
  createArchive(source, archive, "darwin");
  extractArchive(archive, destination, "darwin");
  assert.equal(
    readFileSync(path.join(destination, "Nexa.app", "repetitive.bin")).length,
    256 * 1024,
  );
});

test("zip extraction verifies content CRC before retaining extracted files", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-archive-crc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = Buffer.from("original");
  const tampered = Buffer.from("tampered");
  assert.equal(original.length, tampered.length);
  assertZipRejected(
    root,
    zipFixture([{ name: "Nexa/readme.txt", content: tampered, checksum: checksum(original) }]),
    /zip CRC mismatch for Nexa\/readme\.txt/u,
  );
});

test("zip extraction rejects encryption, unsupported flags, and local flag drift", (t) => {
  const fixtures = [
    {
      label: "encrypted",
      entry: { name: "Nexa/Nexa.exe", flags: ZIP_UTF8_FLAG | 0x0001 },
      pattern: /encrypted zip entry is not supported/u,
    },
    {
      label: "data descriptor",
      entry: { name: "Nexa/Nexa.exe", flags: ZIP_UTF8_FLAG | 0x0008 },
      pattern: /unsupported zip flags/u,
    },
    {
      label: "local mismatch",
      entry: { name: "Nexa/Nexa.exe", localFlags: 0 },
      pattern: /zip flag mismatch/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-archive-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertZipRejected(root, zipFixture([fixture.entry]), fixture.pattern);
  }
});

test("zip extraction rejects duplicate, case-insensitive, and file/directory path conflicts", (t) => {
  const fixtures = [
    {
      label: "duplicate",
      entries: [
        { name: "Nexa/Nexa.exe", content: "first" },
        { name: "Nexa/Nexa.exe", content: "second" },
      ],
      pattern: /duplicate zip path: Nexa\/Nexa\.exe/u,
    },
    {
      label: "case",
      entries: [
        { name: "Nexa/Nexa.exe", content: "first" },
        { name: "nexa/helper.dll", content: "second" },
      ],
      pattern: /case-insensitive zip path collision: Nexa and nexa/u,
    },
    {
      label: "type",
      entries: [
        { name: "Nexa", content: "file" },
        { name: "Nexa/Nexa.exe", content: "nested" },
      ],
      pattern: /zip file\/directory path conflict: Nexa/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-archive-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertZipRejected(root, zipFixture(fixture.entries), fixture.pattern);
  }
});

test("zip extraction rejects traversal, symlink, and special-file entries", (t) => {
  const fixtures = [
    {
      label: "traversal",
      entry: { name: "../escape.exe" },
      pattern: /unsafe archive path/u,
    },
    {
      label: "symlink",
      entry: {
        name: "Nexa/link.exe",
        externalAttributes: ((0o120000 | 0o777) << 16) >>> 0,
      },
      pattern: /unsupported zip symlink entry/u,
    },
    {
      label: "special",
      entry: {
        name: "Nexa/pipe",
        externalAttributes: ((0o010000 | 0o644) << 16) >>> 0,
      },
      pattern: /unsupported zip special-file entry/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-archive-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertZipRejected(root, zipFixture([fixture.entry]), fixture.pattern);
  }
});

test("zip extraction enforces entry, expanded-size, and compression-ratio budgets", (t) => {
  const fixtures = [
    {
      label: "entries",
      bytes: zipFixture([], { count: ZIP_EXTRACTION_LIMITS.maxEntries + 1 }),
      pattern: new RegExp(`zip entry count exceeds ${ZIP_EXTRACTION_LIMITS.maxEntries}`, "u"),
    },
    {
      label: "expanded",
      bytes: zipFixture([
        {
          name: "Nexa/oversized.bin",
          method: 8,
          compressed: Buffer.alloc(0),
          compressedSize: Math.ceil(
            (ZIP_EXTRACTION_LIMITS.maxUncompressedBytes + 1) /
              ZIP_EXTRACTION_LIMITS.maxCompressionRatio,
          ),
          uncompressedSize: ZIP_EXTRACTION_LIMITS.maxUncompressedBytes + 1,
        },
      ]),
      pattern: /zip expanded size exceeds/u,
    },
    {
      label: "ratio",
      bytes: zipFixture([
        {
          name: "Nexa/compression-bomb.bin",
          method: 8,
          compressed: Buffer.alloc(0),
          compressedSize: 1,
          uncompressedSize: ZIP_EXTRACTION_LIMITS.maxCompressionRatio + 1,
        },
      ]),
      pattern: /zip compression ratio exceeds/u,
    },
  ];
  for (const fixture of fixtures) {
    const root = mkdtempSync(path.join(tmpdir(), `nexa-archive-${fixture.label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assertZipRejected(root, fixture.bytes, fixture.pattern);
  }
});

test("zip extraction accepts a valid entry exactly at the compression-ratio boundary", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-archive-ratio-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = Buffer.alloc(4_200);
  const compressed = deflateRawSync(content);
  assert.equal(content.length / compressed.length, ZIP_EXTRACTION_LIMITS.maxCompressionRatio);
  const archive = path.join(root, "boundary.zip");
  const destination = path.join(root, "out");
  writeFileSync(
    archive,
    zipFixture([{ name: "Nexa/boundary.bin", content, compressed, method: 8 }]),
  );
  extractArchive(archive, destination, "win32");
  assert.deepEqual(readFileSync(path.join(destination, "Nexa", "boundary.bin")), content);
});
