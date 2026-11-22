'use strict';
/**
 * 只读 ZIP 解析器（里程碑 4 历史导入）。
 *
 * 只支持 chat-demo 导出使用的单卷 ZIP32：STORE / DEFLATE、UTF-8 文件名、
 * 可选 data descriptor。ZIP64、分卷、加密、符号链接一律拒绝。
 * 解析在内存中完成，按条目读取并校验大小与 CRC，解压后立即丢弃，避免同时
 * 持有全部图片。
 */
const zlib = require('node:zlib');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;

const MAX_ENTRIES = 20000;
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

class ZipError extends Error {
  constructor(reason) {
    super(`Invalid history archive: ${reason}`);
    this.name = 'ZipError';
    this.code = 'INVALID_ARCHIVE';
    this.reason = reason;
  }
}

const fail = (reason) => {
  throw new ZipError(reason);
};

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 严格的 ZIP 路径：拒绝绝对路径、反斜杠、盘符与 . / .. 片段 */
function decodePath(bytes, flags) {
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    fail('文件名不是 UTF-8');
  }
  let path;
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC');
  } catch {
    fail('文件名编码无效');
  }
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path)
  ) {
    fail(`非法路径: ${path}`);
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`非法路径: ${path}`);
  }
  return path;
}

function checkExtra(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      fail('扩展字段截断');
    }
    const id = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    if (id === ZIP64_EXTRA_ID) {
      fail('不支持 ZIP64');
    }
    offset += 4 + length;
    if (offset > bytes.length) {
      fail('扩展字段截断');
    }
  }
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) !== EOCD) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      return offset;
    }
  }
  return -1;
}

class ZipArchive {
  /**
   * @param {Buffer} buffer 完整 ZIP 字节
   * @param {{ maxEntryBytes?: number, maxTotalBytes?: number }} [limits]
   */
  constructor(buffer, limits = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
      fail('文件过小');
    }
    const maxEntryBytes = limits.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES;
    const maxTotalBytes = limits.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES;
    const eocd = findEocd(buffer);
    if (eocd < 0) {
      fail('找不到中央目录结尾');
    }

    const disk = buffer.readUInt16LE(eocd + 4);
    const centralDisk = buffer.readUInt16LE(eocd + 6);
    const diskEntries = buffer.readUInt16LE(eocd + 8);
    const totalEntries = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);

    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== totalEntries ||
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      fail('不支持分卷或 ZIP64');
    }
    if (totalEntries === 0 || totalEntries > MAX_ENTRIES) {
      fail('条目数量异常');
    }
    if (centralOffset + centralSize !== eocd) {
      fail('中央目录位置不连续');
    }

    this.buffer = buffer;
    this.centralOffset = centralOffset;
    this.entries = new Map();
    this.ordered = [];
    this.offsetByPath = new Map();

    let cursor = 0;
    let totalBytes = 0;
    for (let index = 0; index < totalEntries; index++) {
      if (cursor + 46 > centralSize) {
        fail('中央目录截断');
      }
      const base = centralOffset + cursor;
      if (buffer.readUInt32LE(base) !== CENTRAL) {
        fail('中央目录签名错误');
      }
      const flags = buffer.readUInt16LE(base + 8);
      const method = buffer.readUInt16LE(base + 10);
      const crc = buffer.readUInt32LE(base + 16);
      const compressedSize = buffer.readUInt32LE(base + 20);
      const size = buffer.readUInt32LE(base + 24);
      const nameLength = buffer.readUInt16LE(base + 28);
      const extraLength = buffer.readUInt16LE(base + 30);
      const commentLength = buffer.readUInt16LE(base + 32);
      const localOffset = buffer.readUInt32LE(base + 42);
      const externalAttrs = buffer.readUInt32LE(base + 38);
      const next = cursor + 46 + nameLength + extraLength + commentLength;

      if (
        flags & ~0x0808 ||
        (method !== 0 && method !== 8) ||
        compressedSize === 0xffffffff ||
        size === 0xffffffff ||
        (method === 0 && compressedSize !== size) ||
        localOffset >= centralOffset ||
        ((externalAttrs >>> 16) & 0xf000) === 0xa000 ||
        next > centralSize
      ) {
        fail('不支持的条目属性');
      }
      if (size > maxEntryBytes) {
        fail('单条目超过上限');
      }
      totalBytes += size;
      if (totalBytes > maxTotalBytes) {
        fail('解压总量超过上限');
      }

      const name = buffer.subarray(base + 46, base + 46 + nameLength);
      checkExtra(buffer.subarray(base + 46 + nameLength, base + 46 + nameLength + extraLength));
      const path = decodePath(name, flags);
      if (path.endsWith('/') && size !== 0) {
        fail('目录条目包含内容');
      }
      const identity = path.endsWith('/') ? path.slice(0, -1) : path;
      if (this.offsetByPath.has(identity)) {
        fail(`重复条目: ${path}`);
      }
      this.offsetByPath.set(identity, localOffset);
      this.entries.set(path, {
        path,
        flags,
        method,
        crc,
        compressedSize,
        size,
        localOffset,
        name,
      });
      this.ordered.push({ path, localOffset });
      cursor = next;
    }
    if (cursor !== centralSize) {
      fail('中央目录长度不符');
    }
    this.ordered.sort((a, b) => a.localOffset - b.localOffset);
  }

  get paths() {
    return [...this.entries.keys()];
  }

  get firstPath() {
    return this.ordered[0]?.path ?? null;
  }

  has(path) {
    return this.entries.has(path);
  }

  /** 读取并校验单个条目；调用方负责限制 JSON/图片各自的业务上限 */
  read(path, { maxBytes } = {}) {
    const entry = this.entries.get(path);
    if (!entry) {
      fail(`条目不存在: ${path}`);
    }
    if (maxBytes !== undefined && entry.size > maxBytes) {
      fail(`条目超过上限: ${path}`);
    }
    const offset = entry.localOffset;
    if (offset + 30 > this.centralOffset) {
      fail(`本地头截断: ${path}`);
    }
    if (this.buffer.readUInt32LE(offset) !== LOCAL) {
      fail(`本地头签名错误: ${path}`);
    }
    const flags = this.buffer.readUInt16LE(offset + 6);
    const method = this.buffer.readUInt16LE(offset + 8);
    const nameLength = this.buffer.readUInt16LE(offset + 26);
    const extraLength = this.buffer.readUInt16LE(offset + 28);
    if (
      flags !== entry.flags ||
      method !== entry.method ||
      nameLength !== entry.name.length
    ) {
      fail(`本地头与中央目录不一致: ${path}`);
    }
    const localName = this.buffer.subarray(offset + 30, offset + 30 + nameLength);
    if (!localName.equals(entry.name)) {
      fail(`文件名不一致: ${path}`);
    }
    checkExtra(
      this.buffer.subarray(offset + 30 + nameLength, offset + 30 + nameLength + extraLength)
    );
    const start = offset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.centralOffset) {
      fail(`条目数据越界: ${path}`);
    }

    const raw = this.buffer.subarray(start, end);
    let data;
    if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: entry.size });
      } catch {
        fail(`解压失败: ${path}`);
      }
    } else {
      data = raw;
    }
    if (data.length !== entry.size) {
      fail(`解压后长度不符: ${path}`);
    }
    if (crc32(data) !== entry.crc) {
      fail(`CRC 校验失败: ${path}`);
    }
    return data;
  }
}

module.exports = {
  ZipArchive,
  ZipError,
  crc32,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
};
