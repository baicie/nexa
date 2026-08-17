import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const ZIP_EXTRACTION_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
});

export const TAR_EXTRACTION_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
});

const TAR_BLOCK_SIZE = 512;
const TAR_MAX_ARCHIVE_BYTES =
  TAR_EXTRACTION_LIMITS.maxUncompressedBytes +
  TAR_EXTRACTION_LIMITS.maxEntries * TAR_BLOCK_SIZE * 2 +
  TAR_BLOCK_SIZE * 2;

const ZIP_ENCRYPTION_FLAGS = 0x2041;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DEFLATE_OPTION_FLAGS = 0x0006;
const ZIP_SUPPORTED_FLAGS = ZIP_UTF8_FLAG | ZIP_DEFLATE_OPTION_FLAGS;

function fail(message) {
  throw new Error(`Archive contract: ${message}`);
}

function safeRelative(name) {
  if (name.includes("\0")) fail("archive path contains a NUL byte");
  const normalized = name.replaceAll("\\", "/");
  const trimmed = normalized.replace(/\/+$/u, "");
  if (
    trimmed.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(trimmed) ||
    trimmed.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`unsafe archive path: ${name}`);
  }
  return trimmed;
}

function tarOctal(buffer, start, length, field) {
  const raw = buffer.subarray(start, start + length);
  if (raw[0] & 0x80) fail(`base-256 tar ${field} is not supported`);
  const value = raw
    .toString("ascii")
    .replace(/[\0 ]+$/u, "")
    .replace(/^ +/u, "");
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) fail(`invalid tar ${field}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail(`tar ${field} exceeds the safe integer range`);
  return parsed;
}

function tarText(header, start, length, field) {
  const raw = header.subarray(start, start + length);
  const terminator = raw.indexOf(0);
  const value = terminator === -1 ? raw : raw.subarray(0, terminator);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    fail(`tar ${field} is not valid UTF-8`);
  }
}

function tarName(header) {
  const name = tarText(header, 0, 100, "name");
  const prefix = tarText(header, 345, 155, "prefix");
  return prefix ? `${prefix}/${name}` : name;
}

function verifyTarHeader(header) {
  const expected = tarOctal(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) fail("tar header checksum mismatch");
  if (header.toString("ascii", 257, 263) !== "ustar\0") {
    fail("unsupported tar format: ustar magic is required");
  }
  if (header.toString("ascii", 263, 265) !== "00") {
    fail("unsupported tar format: ustar version 00 is required");
  }
}

function registerArchivePath(nodes, name, directory, format) {
  const parts = name.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const current = parts.slice(0, index + 1).join("/");
    const key = current.normalize("NFC").toLowerCase();
    const kind = index === parts.length - 1 && !directory ? "file" : "directory";
    const explicit = index === parts.length - 1;
    const previous = nodes.get(key);
    if (!previous) {
      nodes.set(key, { name: current, kind, explicit });
      continue;
    }
    if (previous.name !== current) {
      fail(`case-insensitive ${format} path collision: ${previous.name} and ${current}`);
    }
    if (previous.kind !== kind) fail(`${format} file/directory path conflict: ${current}`);
    if (explicit && previous.explicit) fail(`duplicate ${format} path: ${current}`);
    if (explicit) previous.explicit = true;
  }
}

function extractTar(bytes, destination) {
  if (bytes.length % TAR_BLOCK_SIZE !== 0) fail("tar archive is not block-aligned");
  let offset = 0;
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  const pathNodes = new Map();
  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (offset + TAR_BLOCK_SIZE * 2 > bytes.length) {
        fail("tar end-of-archive marker is missing");
      }
      const second = bytes.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2);
      if (!second.every((byte) => byte === 0)) fail("tar end-of-archive marker is missing");
      if (!bytes.subarray(offset + TAR_BLOCK_SIZE * 2).every((byte) => byte === 0)) {
        fail("non-zero bytes after tar end-of-archive marker");
      }
      return;
    }
    verifyTarHeader(header);
    const name = safeRelative(tarName(header));
    const type = header[156] || 48;
    const size = tarOctal(header, 124, 12, "size");
    const directory = type === 53;
    if (![0, 48, 53].includes(type)) fail(`unsupported tar entry type for ${name}`);
    if (directory && size !== 0) fail(`tar directory entry must not contain data: ${name}`);
    entryCount += 1;
    if (entryCount > TAR_EXTRACTION_LIMITS.maxEntries) {
      fail(`tar entry count exceeds ${TAR_EXTRACTION_LIMITS.maxEntries}`);
    }
    if (!directory) {
      totalUncompressedBytes += size;
      if (totalUncompressedBytes > TAR_EXTRACTION_LIMITS.maxUncompressedBytes) {
        fail(`tar expanded size exceeds ${TAR_EXTRACTION_LIMITS.maxUncompressedBytes} bytes`);
      }
    }
    registerArchivePath(pathNodes, name, directory, "tar");
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (
      !Number.isSafeInteger(dataEnd) ||
      !Number.isSafeInteger(paddedEnd) ||
      paddedEnd > bytes.length
    ) {
      fail(`truncated tar entry: ${name}`);
    }
    if (!bytes.subarray(dataEnd, paddedEnd).every((byte) => byte === 0)) {
      fail(`non-zero tar entry padding for ${name}`);
    }
    const target = path.join(destination, name);
    if (directory) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes.subarray(dataStart, dataEnd), { flag: "wx" });
      const mode = tarOctal(header, 100, 8, "mode") & 0o777;
      if (mode) chmodSync(target, mode);
    }
    offset = paddedEnd;
  }
  fail("tar end-of-archive marker is missing");
}

function requireRange(bytes, offset, length, description) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    fail(`truncated ${description}`);
  }
}

function findZipEnd(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  fail("zip end-of-central-directory record is missing");
}

function decodeZipName(raw, flags) {
  if (raw.length === 0) fail("zip entry name must not be empty");
  if (raw.includes(0)) fail("zip entry name contains a NUL byte");
  if ((flags & ZIP_UTF8_FLAG) === 0 && raw.some((byte) => byte > 0x7f)) {
    fail("non-ASCII zip entry names must set the UTF-8 flag");
  }
  try {
    return new TextDecoder(flags & ZIP_UTF8_FLAG ? "utf-8" : "ascii", { fatal: true }).decode(raw);
  } catch {
    fail("zip entry name is not valid UTF-8");
  }
}

function validateZipFlags(flags, method, name, location) {
  if (flags & ZIP_ENCRYPTION_FLAGS) fail(`encrypted zip entry is not supported: ${name}`);
  if (flags & ~ZIP_SUPPORTED_FLAGS) {
    fail(`unsupported zip flags in ${location} entry for ${name}`);
  }
  if (method !== 8 && flags & ZIP_DEFLATE_OPTION_FLAGS) {
    fail(`deflate-only zip flags used by ${location} entry for ${name}`);
  }
}

function registerZipPath(nodes, name, directory) {
  registerArchivePath(nodes, name, directory, "zip");
}

function zipCrc32(bytes) {
  return typeof crc32 === "function" ? crc32(bytes) >>> 0 : crc32Fallback(bytes);
}

function parseZip(bytes) {
  const end = findZipEnd(bytes);
  requireRange(bytes, end, 22, "zip end-of-central-directory record");
  const disk = bytes.readUInt16LE(end + 4);
  const directoryDisk = bytes.readUInt16LE(end + 6);
  const diskCount = bytes.readUInt16LE(end + 8);
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskCount !== count) {
    fail("multi-disk zip archives are not supported");
  }
  if (count > ZIP_EXTRACTION_LIMITS.maxEntries) {
    fail(`zip entry count exceeds ${ZIP_EXTRACTION_LIMITS.maxEntries}`);
  }
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    fail("ZIP64 archives are not supported");
  }
  if (directoryOffset + directorySize !== end) fail("invalid zip central directory bounds");
  requireRange(bytes, directoryOffset, directorySize, "zip central directory");

  const entries = [];
  const pathNodes = new Map();
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    requireRange(bytes, offset, 46, "zip central directory entry");
    if (bytes.readUInt32LE(offset) !== 0x02014b50) fail("invalid zip central directory");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, offset, entryLength, "zip central directory entry");
    if (offset + entryLength > end) fail("zip central directory entry exceeds its bounds");
    if (diskStart !== 0) fail("multi-disk zip entries are not supported");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      fail("ZIP64 entries are not supported");
    }
    if (![0, 8].includes(method)) fail("unsupported zip compression method");

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const decodedName = decodeZipName(rawName, flags);
    const name = safeRelative(decodedName);
    validateZipFlags(flags, method, name, "central");

    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (unixType === 0o120000) fail(`unsupported zip symlink entry: ${name}`);
    if (![0, 0o040000, 0o100000].includes(unixType)) {
      fail(`unsupported zip special-file entry: ${name}`);
    }
    const directory =
      decodedName.endsWith("/") ||
      decodedName.endsWith("\\") ||
      Boolean(externalAttributes & 0x10) ||
      unixType === 0o040000;
    if (directory && unixType === 0o100000) {
      fail(`zip entry has conflicting file and directory metadata: ${name}`);
    }
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0 || checksum !== 0)) {
      fail(`zip directory entry must not contain data: ${name}`);
    }
    if (!directory && unixType === 0o040000) {
      fail(`zip entry has conflicting file and directory metadata: ${name}`);
    }
    if (!directory && method === 0 && compressedSize !== uncompressedSize) {
      fail(`stored zip entry size mismatch for ${name}`);
    }
    if (
      !directory &&
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize / compressedSize > ZIP_EXTRACTION_LIMITS.maxCompressionRatio)
    ) {
      fail(
        `zip compression ratio exceeds ${ZIP_EXTRACTION_LIMITS.maxCompressionRatio} for ${name}`,
      );
    }

    registerZipPath(pathNodes, name, directory);
    if (!directory) {
      totalCompressedBytes += compressedSize;
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > ZIP_EXTRACTION_LIMITS.maxUncompressedBytes) {
        fail(`zip expanded size exceeds ${ZIP_EXTRACTION_LIMITS.maxUncompressedBytes} bytes`);
      }
    }
    entries.push({
      checksum,
      compressedSize,
      directory,
      externalAttributes,
      flags,
      localOffset,
      method,
      name,
      rawName: Buffer.from(rawName),
      uncompressedSize,
    });
    offset += entryLength;
  }
  if (offset !== end) fail("zip central directory entry count or size mismatch");
  if (
    totalUncompressedBytes > 0 &&
    (totalCompressedBytes === 0 ||
      totalUncompressedBytes / totalCompressedBytes > ZIP_EXTRACTION_LIMITS.maxCompressionRatio)
  ) {
    fail(`zip aggregate compression ratio exceeds ${ZIP_EXTRACTION_LIMITS.maxCompressionRatio}`);
  }

  const localRanges = [];
  for (const entry of entries) {
    requireRange(bytes, entry.localOffset, 30, `zip local entry for ${entry.name}`);
    if (entry.localOffset + 30 > directoryOffset) fail(`invalid zip local entry: ${entry.name}`);
    if (bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      fail(`invalid zip local entry: ${entry.name}`);
    }
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6);
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8);
    const localChecksum = bytes.readUInt32LE(entry.localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(entry.localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(entry.localOffset + 22);
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    requireRange(bytes, entry.localOffset, localHeaderLength, `zip local entry for ${entry.name}`);
    if (entry.localOffset + localHeaderLength > directoryOffset) {
      fail(`invalid zip local entry: ${entry.name}`);
    }
    const localName = bytes.subarray(
      entry.localOffset + 30,
      entry.localOffset + 30 + localNameLength,
    );
    if (!localName.equals(entry.rawName)) fail(`zip local name mismatch for ${entry.name}`);
    validateZipFlags(localFlags, localMethod, entry.name, "local");
    if (localFlags !== entry.flags) fail(`zip flag mismatch for ${entry.name}`);
    if (localMethod !== entry.method) fail(`zip compression method mismatch for ${entry.name}`);
    if (localChecksum !== entry.checksum) fail(`zip local CRC mismatch for ${entry.name}`);
    if (
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ) {
      fail(`zip local size mismatch for ${entry.name}`);
    }
    const compressedStart = entry.localOffset + localHeaderLength;
    const compressedEnd = compressedStart + entry.compressedSize;
    if (compressedEnd > directoryOffset) fail(`truncated zip content for ${entry.name}`);
    entry.compressedStart = compressedStart;
    entry.compressedEnd = compressedEnd;
    localRanges.push({ start: entry.localOffset, end: compressedEnd, name: entry.name });
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      fail(
        `overlapping zip local entries: ${localRanges[index - 1].name} and ${localRanges[index].name}`,
      );
    }
  }
  return entries;
}

function extractZip(bytes, destination) {
  const entries = parseZip(bytes);
  let actualExpandedBytes = 0;
  for (const entry of entries) {
    const target = path.join(destination, entry.name);
    if (entry.directory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const compressed = bytes.subarray(entry.compressedStart, entry.compressedEnd);
    let content;
    try {
      content =
        entry.method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
    } catch {
      fail(`could not decompress zip entry: ${entry.name}`);
    }
    if (content.length !== entry.uncompressedSize) fail(`zip size mismatch for ${entry.name}`);
    if (zipCrc32(content) !== entry.checksum) fail(`zip CRC mismatch for ${entry.name}`);
    actualExpandedBytes += content.length;
    if (actualExpandedBytes > ZIP_EXTRACTION_LIMITS.maxUncompressedBytes) {
      fail(`zip expanded size exceeds ${ZIP_EXTRACTION_LIMITS.maxUncompressedBytes} bytes`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx" });
    const mode = (entry.externalAttributes >>> 16) & 0o777;
    if (mode) chmodSync(target, mode);
  }
}

function collectFiles(root, current = "") {
  return readdirSync(path.join(root, current), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(current.replaceAll(path.sep, "/"), entry.name);
      if (entry.isDirectory()) return collectFiles(root, relative);
      if (!entry.isFile() || entry.isSymbolicLink())
        fail(`archive source contains non-regular file: ${relative}`);
      return [relative];
    })
    .sort();
}

function splitTarName(relative) {
  if (Buffer.byteLength(relative, "utf8") <= 100) return { name: relative, prefix: "" };
  const separators = [...relative.matchAll(/\//gu)].map(({ index }) => index).reverse();
  for (const separator of separators) {
    const prefix = relative.slice(0, separator);
    const name = relative.slice(separator + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  fail(`tar path cannot be represented by ustar: ${relative}`);
}

function tarHeader(relative, size, mode, type = "0") {
  const { name, prefix } = splitTarName(relative);
  const header = Buffer.alloc(512);
  header.write(name, 0, Buffer.byteLength(name), "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(prefix, 345, Buffer.byteLength(prefix), "utf8");
  header.fill(32, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function createTar(root) {
  const chunks = [];
  const files = collectFiles(root);
  if (files.length > TAR_EXTRACTION_LIMITS.maxEntries) {
    fail(`tar entry count exceeds ${TAR_EXTRACTION_LIMITS.maxEntries}`);
  }
  let totalUncompressedBytes = 0;
  for (const relative of files) {
    safeRelative(relative);
    const absolute = path.join(root, relative);
    const content = readFileSync(absolute);
    totalUncompressedBytes += content.length;
    if (totalUncompressedBytes > TAR_EXTRACTION_LIMITS.maxUncompressedBytes) {
      fail(`tar expanded size exceeds ${TAR_EXTRACTION_LIMITS.maxUncompressedBytes} bytes`);
    }
    const mode = statSync(absolute).mode & 0o777;
    chunks.push(tarHeader(relative, content.length, mode), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function crc32Fallback(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(relative, content, mode) {
  const name = Buffer.from(relative);
  const deflated = deflateRawSync(content, { level: 9 });
  const useDeflate =
    deflated.length < content.length &&
    (content.length === 0 ||
      content.length / deflated.length <= ZIP_EXTRACTION_LIMITS.maxCompressionRatio);
  const compressed = useDeflate ? deflated : content;
  const method = useDeflate ? 8 : 0;
  const checksum = zipCrc32(content);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  return { local, compressed, name, checksum, method, mode };
}

function createZip(root, destination) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const files = collectFiles(root);
  if (files.length > ZIP_EXTRACTION_LIMITS.maxEntries) {
    fail(`zip entry count exceeds ${ZIP_EXTRACTION_LIMITS.maxEntries}`);
  }
  let totalUncompressedBytes = 0;
  for (const relative of files) {
    const content = readFileSync(path.join(root, relative));
    totalUncompressedBytes += content.length;
    if (totalUncompressedBytes > ZIP_EXTRACTION_LIMITS.maxUncompressedBytes) {
      fail(`zip expanded size exceeds ${ZIP_EXTRACTION_LIMITS.maxUncompressedBytes} bytes`);
    }
    const entry = zipEntry(relative, content, statSync(path.join(root, relative)).mode & 0o777);
    locals.push(entry.local, entry.compressed);
    const central = Buffer.alloc(46 + entry.name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.checksum, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE(((0o100000 | (entry.mode & 0o777)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    entry.name.copy(central, 46);
    centrals.push(central);
    offset += entry.local.length + entry.compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(destination, Buffer.concat([...locals, directory, end]));
}

export function extractArchive(archive, destination, platform) {
  mkdirSync(destination, { recursive: false });
  try {
    const bytes = readFileSync(archive);
    if (platform === "darwin") {
      let tar;
      try {
        tar = gunzipSync(bytes, { maxOutputLength: TAR_MAX_ARCHIVE_BYTES + 1 });
      } catch {
        fail("could not decompress tar archive within its extraction budget");
      }
      if (tar.length > TAR_MAX_ARCHIVE_BYTES) {
        fail(`tar archive size exceeds ${TAR_MAX_ARCHIVE_BYTES} bytes`);
      }
      if (
        tar.length > 0 &&
        (bytes.length === 0 ||
          tar.length / bytes.length > TAR_EXTRACTION_LIMITS.maxCompressionRatio)
      ) {
        fail(`tar compression ratio exceeds ${TAR_EXTRACTION_LIMITS.maxCompressionRatio}`);
      }
      extractTar(tar, destination);
    } else if (platform === "win32") extractZip(bytes, destination);
    else fail(`unsupported archive platform: ${platform}`);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function createArchive(source, destination, platform) {
  if (platform === "darwin") {
    const tar = createTar(source);
    let compressed = gzipSync(tar, { level: 9, mtime: 0 });
    if (tar.length / compressed.length > TAR_EXTRACTION_LIMITS.maxCompressionRatio) {
      compressed = gzipSync(tar, { level: 0, mtime: 0 });
    }
    writeFileSync(destination, compressed);
  } else if (platform === "win32") createZip(source, destination);
  else fail(`unsupported archive platform: ${platform}`);
}

function isMachO(bytes) {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(magic);
}

function isPe(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return false;
  const header = bytes.readUInt32LE(60);
  return header + 4 <= bytes.length && bytes.toString("ascii", header, header + 4) === "PE\0\0";
}

export function inventoryBinaries(root, platform) {
  const binaries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        const bytes = readFileSync(absolute);
        if ((platform === "darwin" && isMachO(bytes)) || (platform === "win32" && isPe(bytes))) {
          binaries.push({
            absolute,
            relative: path.relative(root, absolute),
            depth: path.relative(root, absolute).split(path.sep).length,
          });
        }
      }
    }
  };
  walk(root);
  return binaries.sort(
    (left, right) => right.depth - left.depth || left.relative.localeCompare(right.relative),
  );
}
