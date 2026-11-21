'use strict';
/**
 * Argon2id 哈希 / 验证 + pepper + 参数升级检测 + 并发闸。
 * 对应方案 §6.2.2、§6.2.6。
 */
const argon2 = require('argon2');
const { config } = require('../config');

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: config.argon2.memoryCost,
  timeCost: config.argon2.timeCost,
  parallelism: config.argon2.parallelism,
};

// pepper 必须为 Buffer；不在 PHC 中留痕，故版本靠 users.argon2_key_version 标记
const SECRET = Buffer.from(config.argon2.secret, 'utf8');

async function hashPassword(plain) {
  return argon2.hash(plain, { ...ARGON2_OPTIONS, secret: SECRET });
}

async function verifyPassword(storedHash, candidate) {
  // verify 是异步的，必须 await；误当同步使用会恒为 true
  return argon2.verify(storedHash, candidate, { secret: SECRET });
}

/**
 * 判断 PHC 参数是否低于当前策略（供 rehash-on-login）。
 * 只比较 m/t/p 三项，不解析盐与摘要。
 */
function needsRehash(phc) {
  const m = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc || '');
  if (!m) return true; // 非预期格式，按需升级处理
  const [, mem, time, par] = m.map(Number);
  return (
    mem < config.argon2.memoryCost ||
    time < config.argon2.timeCost ||
    par < config.argon2.parallelism
  );
}

// ---------------- Argon2 并发闸（方案 §6.2.6）----------------
// 未认证请求可触发 Argon2，这是最贵的操作；不设闸时数 rps 即可打满 2 核。
let inflight = 0;
let queued = 0;
const waiters = [];

function releaseOne() {
  const next = waiters.shift();
  if (next) next();
}

async function acquireSlot() {
  if (inflight < config.hashGate.maxConcurrent) {
    inflight++;
    return;
  }
  if (queued >= config.hashGate.queueLimit) {
    const e = new Error('auth busy');
    e.code = 'AUTH_BUSY';
    throw e;
  }
  queued++;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        const e = new Error('auth busy');
        e.code = 'AUTH_BUSY';
        reject(e);
      }, config.hashGate.queueTimeoutMs);
      const entry = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(entry);
    });
    inflight++;
  } finally {
    queued--;
  }
}

function releaseSlot() {
  inflight--;
  releaseOne();
}

/**
 * 所有可能触发 Argon2 的操作（含 dummy verify）都必须走同一闸门，
 * 否则时序防护本身会成为 DoS 入口。
 */
async function withHashSlot(fn) {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

// ---------------- dummy verify（抗时序枚举，方案 §5.1 步骤 4）----------------
let DUMMY_HASH = null;
async function getDummyHash() {
  if (!DUMMY_HASH) {
    DUMMY_HASH = await hashPassword('dummy-' + require('node:crypto').randomBytes(16).toString('hex'));
  }
  return DUMMY_HASH;
}

/** 启动自检时预热，避免重启后首个「用户不存在」请求付两次 Argon2 */
async function warmup() {
  await getDummyHash();
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
  withHashSlot,
  getDummyHash,
  warmup,
  ARGON2_OPTIONS,
};