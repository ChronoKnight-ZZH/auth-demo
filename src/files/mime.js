'use strict';
/**
 * 轻量 MIME 嗅探：只信任文件头，不信任客户端声明。
 * 覆盖聊天附件里最常见的图片与文档；识别失败时退回 application/octet-stream。
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_EXT = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/bmp', 'bmp'],
]);

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
};

/** 客户端声明只用于「非图片」时的兜底展示；图片身份一律以文件头为准 */
function sanitizeDeclared(value) {
  if (typeof value !== 'string') return '';
  const mime = value.split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return '';
  return mime.slice(0, 128);
}

function sniff(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return null;
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return 'image/gif';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avi')) return 'image/avif';
  }
  if (head.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) {
    // ZIP 容器：具体是 docx/xlsx/pptx/epub 由扩展名决定
    return 'application/zip';
  }
  // 文本：可打印 ASCII / UTF-8 占比高
  let printable = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === 0) return null;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0x80) printable++;
  }
  if (printable / head.length > 0.95) return 'text/plain';
  return null;
}

function extOf(name) {
  const ext = path.extname(typeof name === 'string' ? name : '').slice(1).toLowerCase();
  return ext;
}

/**
 * 读文件头判定 MIME 与 isImage。
 * @param {string} filePath 临时文件或原件路径
 * @param {{ name?: string, declared?: string }} hints
 */
async function detect(filePath, { name = '', declared = '' } = {}) {
  let head = Buffer.alloc(0);
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    head = Buffer.alloc(0);
  }

  const sniffed = sniff(head);
  if (sniffed && sniffed.startsWith('image/')) {
    return { mime: sniffed, isImage: true };
  }
  if (sniffed === 'application/pdf') return { mime: sniffed, isImage: false };

  const ext = extOf(name);
  const byExt = MIME_BY_EXT[ext] || '';
  if (byExt.startsWith('image/')) {
    // 声明的图片扩展名但文件头不是已知图片：按二进制处理，避免把 SVG/HTML 当图片内联
    return { mime: 'application/octet-stream', isImage: false };
  }
  if (byExt) return { mime: byExt, isImage: false };

  const safeDeclared = sanitizeDeclared(declared);
  if (safeDeclared.startsWith('image/')) {
    return { mime: 'application/octet-stream', isImage: false };
  }
  if (safeDeclared) return { mime: safeDeclared, isImage: false };
  if (sniffed) return { mime: sniffed, isImage: false };
  return { mime: 'application/octet-stream', isImage: false };
}

const isInlineImage = (mime) => IMAGE_EXT.has(mime);

module.exports = { detect, sniff, sanitizeDeclared, isInlineImage, extOf };
