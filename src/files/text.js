'use strict';
/**
 * 文本原件 → UTF-8 转码。
 *
 * 浏览器只有在 Content-Type 为 text/* 且 Content-Disposition 为 inline 时
 * 才会直接展示文本，否则一律走下载。Windows 上导出的 .txt/.md/.csv 常见
 * GBK/GB18030（记事本「ANSI」）或带 BOM 的 UTF-16LE，直接按 UTF-8 发送会乱码，
 * 因此在服务端读取后统一转成 UTF-8；内容保持纯文本，不解析、不执行。
 *
 * 识别顺序：BOM → 无 BOM 的 UTF-16（NUL 分布）→ 合法 UTF-8 → GB18030/大五码等
 * 常见东亚编码 → windows-1252 兜底。GB18030 优先，符合中文部署环境。
 */
const fsp = require('node:fs/promises');
const { isUtf8 } = require('node:buffer');
const { TextDecoder } = require('node:util');

/** 非 UTF-8 时的候选编码，按中文环境常见程度排序 */
const LEGACY_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'euc-kr'];

/** 解码失败返回 null；fatal=false 时用替换字符兜底 */
function decode(buffer, encoding, fatal = true) {
  try {
    return new TextDecoder(encoding, { fatal }).decode(buffer);
  } catch {
    return null;
  }
}

/** 无 BOM 的 UTF-16 只能靠 NUL 分布猜：ASCII 文本的 UTF-16 每个字符都带一个 0x00 */
function guessUtf16(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 0) evenZero++;
    else oddZero++;
  }
  const zeros = evenZero + oddZero;
  if (zeros / sample.length < 0.2) return null;
  if (oddZero > evenZero * 3) return 'utf-16le';
  if (evenZero > oddZero * 3) return 'utf-16be';
  return null;
}

/** 纯函数：把任意文本字节转成 UTF-8，返回 { body, encoding } */
function convert(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { body: Buffer.alloc(0), encoding: 'utf-8' };
  }

  // BOM 最可靠：UTF-8 BOM 直接去掉（避免渲染出不可见的 U+FEFF），UTF-16 按声明解码
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { body: buffer.subarray(3), encoding: 'utf-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const text = decode(buffer.subarray(2), 'utf-16le');
    if (text !== null) return { body: Buffer.from(text, 'utf8'), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const text = decode(buffer.subarray(2), 'utf-16be');
    if (text !== null) return { body: Buffer.from(text, 'utf8'), encoding: 'utf-16be' };
  }

  // 全 NUL 的 UTF-16 在字节层面也是合法 UTF-8，必须先于 isUtf8 判断
  const utf16 = guessUtf16(buffer);
  if (utf16) {
    const text = decode(buffer, utf16);
    if (text !== null) return { body: Buffer.from(text, 'utf8'), encoding: utf16 };
  }

  if (isUtf8(buffer)) return { body: buffer, encoding: 'utf-8' };

  for (const encoding of LEGACY_ENCODINGS) {
    const text = decode(buffer, encoding);
    if (text !== null) return { body: Buffer.from(text, 'utf8'), encoding };
  }

  // 兜底：windows-1252 永不失败；ICU 不完整时退回 latin1，至少保持字节可读
  const latin1 = decode(buffer, 'windows-1252', false) ?? buffer.toString('latin1');
  return { body: Buffer.from(latin1, 'utf8'), encoding: 'windows-1252' };
}

/**
 * 读取原件并转码；超过上限返回 null，由路由退回附件下载语义。
 * @param {string} filePath 原件路径
 * @param {{ maxBytes: number }} options
 */
async function transcodeToUtf8(filePath, { maxBytes }) {
  const info = await fsp.stat(filePath);
  if (!info.isFile() || info.size > maxBytes) return null;
  const buffer = await fsp.readFile(filePath);
  return convert(buffer);
}

module.exports = { convert, transcodeToUtf8 };
