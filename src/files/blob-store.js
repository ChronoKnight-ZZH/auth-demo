'use strict';
/**
 * 内容寻址文件存储（里程碑 3）。
 *
 * 布局：
 *   <dir>/tmp/<uuid>                     上传中的临时文件
 *   <dir>/blobs/<key[0:2]>/<key>         原子落盘后的原件
 *
 * key 默认等于 sha256；DEDUPE_SCOPE=user 时为 HMAC(secret, userId:sha256)，
 * 只在本用户内去重。路径完全由服务端生成，不接受任何用户输入拼接。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { config } = require('../config');

const KEY_RE = /^[a-f0-9]{64}$/;

function blobDir() {
  return path.join(config.files.dir, 'blobs');
}

function tmpDir() {
  return path.join(config.files.dir, 'tmp');
}

/** 校验存储键，挡住任何路径穿越 */
function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    const error = new Error('invalid storage key');
    error.code = 'INVALID_STORAGE_KEY';
    throw error;
  }
  return key;
}

function resolveBlobPath(key) {
  assertKey(key);
  return path.join(blobDir(), key.slice(0, 2), key);
}

function dedupeSecret() {
  return config.files.tokenSecret || config.argon2.secret;
}

/** 计算实际存储键；切换去重策略只影响新上传，旧文件按各自 key 继续可读 */
function storageKeyFor(userId, sha256) {
  assertKey(sha256);
  if (config.files.dedupeScope !== 'user') return sha256;
  return crypto
    .createHmac('sha256', dedupeSecret())
    .update(`user:${userId}:${sha256}`)
    .digest('hex');
}

async function init() {
  await fsp.mkdir(blobDir(), { recursive: true });
  await fsp.mkdir(tmpDir(), { recursive: true });
  // 启动自检：目录可写
  await fsp.access(blobDir(), fs.constants.W_OK);
  await fsp.access(tmpDir(), fs.constants.W_OK);
}

/**
 * 流式写入：边收边算 sha256，超限立即中断并删除临时文件。
 * 返回 { sha256, size }，调用方再决定是否落库。
 */
async function putStream(stream, { limit = config.files.maxBytes } = {}) {
  await init();
  const tmp = path.join(tmpDir(), crypto.randomUUID());
  const hash = crypto.createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('file too large');
        error.code = 'FILE_TOO_LARGE';
        callback(error);
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, counter, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    // 先 fsync 再 rename，避免掉电后得到半截文件
    const handle = await fsp.open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = hash.digest('hex');
    return { sha256, size, tmp };
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 把临时文件原子移动到内容寻址位置。同内容已存在时直接丢弃临时文件。
 * 返回 { sha256, size, storageKey, deduped }。
 */
async function commit(tmp, sha256, size, userId) {
  const storageKey = storageKeyFor(userId, sha256);
  const target = resolveBlobPath(storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(tmp, target);
    return { sha256, size, storageKey, deduped: false };
  } catch (error) {
    // Windows 上 rename 到已存在文件会失败：按去重处理
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      const stat = await fsp.stat(target).catch(() => null);
      if (stat) {
        return { sha256, size: stat.size, storageKey, deduped: true };
      }
    }
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function stat(storageKey) {
  const target = resolveBlobPath(storageKey);
  try {
    const info = await fsp.stat(target);
    if (!info.isFile()) return null;
    return { path: target, size: info.size };
  } catch {
    return null;
  }
}

function createReadStream(storageKey, range) {
  assertKey(storageKey);
  return fs.createReadStream(resolveBlobPath(storageKey), range);
}

async function remove(storageKey) {
  await fsp.rm(resolveBlobPath(storageKey), { force: true }).catch(() => {});
}

/** 解析 `Range: bytes=start-end`；不支持多段，非法/越界返回 null（按整文件返回） */
function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  let start;
  let end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

module.exports = {
  init,
  putStream,
  commit,
  stat,
  remove,
  createReadStream,
  parseRange,
  resolveBlobPath,
  storageKeyFor,
};
