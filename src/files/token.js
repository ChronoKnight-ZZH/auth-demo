'use strict';
/**
 * 文件访问票据（capability token）。
 *
 * 格式：base64url(payload) + "." + base64url(HMAC-SHA256(payload))
 * claims：{ v, kid, fid, uid, sid, ty, iat, exp }
 *
 * 票据不落库、不写进会话 JSON；验证是无状态的。
 * 票据只证明「服务端签发过」，真正的授权仍需回查文件归属与会话存活。
 */
const crypto = require('node:crypto');
const { config } = require('../config');

const TYPES = new Set(['t', 'p', 'r']);
const MAX_TOKEN_CHARS = 2048;

function secret() {
  // 生产应显式配置 FILE_TOKEN_SECRET；缺省用 PEPPER 做域分离派生
  if (config.files.tokenSecret) return config.files.tokenSecret;
  return crypto.createHash('sha256').update(`file-token:${config.argon2.secret}`).digest();
}

function b64u(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest();
}

function issue({ fileId, userId, sessionId, type }) {
  if (!TYPES.has(type)) throw new Error('invalid file token type');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    kid: config.files.keyId,
    fid: fileId,
    uid: Number(userId),
    sid: sessionId,
    ty: type,
    iat: now,
    exp: now + Math.max(1, Math.floor(config.files.tokenTtlMs / 1000)),
  };
  const payload = b64u(JSON.stringify(claims));
  return `${payload}.${b64u(sign(payload))}`;
}

/** 验签 + 验过期；任何不合法都返回 null（上层统一 403） */
function verify(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!payload || !signature) return null;

  const expected = sign(payload);
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  if (claims.v !== 1 || typeof claims.fid !== 'string' || typeof claims.sid !== 'string') return null;
  if (!Number.isFinite(claims.uid) || !TYPES.has(claims.ty)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

module.exports = { issue, verify, TYPES };
