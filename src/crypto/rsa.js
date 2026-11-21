'use strict';
/**
 * RSA-OAEP 解密 + 长度前缀拼接协议。
 * 对应方案 §3.1、§5.1、§6.2.1、§6.2.7。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { config } = require('../config');

const PRIVATE_KEY = fs.readFileSync(config.rsa.privateKeyPath, 'utf8');
const PUBLIC_KEY = fs.readFileSync(config.rsa.publicKeyPath, 'utf8');

/**
 * 解密。失败时抛错，调用方必须折叠为统一的 401（方案 §5.1 步骤 2）。
 */
function decryptCredentials(encryptedBase64) {
  if (typeof encryptedBase64 !== 'string' || encryptedBase64.length === 0) {
    throw new Error('empty ciphertext');
  }
  const buf = Buffer.from(encryptedBase64, 'base64');
  // RSA-2048 密文固定 256 字节；长度不符直接判为无效
  if (buf.length !== 256) throw new Error('bad ciphertext length');
  return crypto
    .privateDecrypt(
      { key: PRIVATE_KEY, padding: config.rsa.padding, oaepHash: config.rsa.oaepHash },
      buf
    )
    .toString('utf8');
}

/**
 * 拼接协议： "v1\n" + byteLength(username) + "\n" + username + password
 * 用长度前缀而非 "||" 分隔，避免用户名含分隔符时构造出与另一账号相同的明文字段。
 */
function encodePayload(username, password) {
  const ub = Buffer.from(username, 'utf8');
  return Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'),
    ub,
    Buffer.from(password, 'utf8'),
  ]);
}

function decodePayload(text) {
  const buf = Buffer.from(text, 'utf8');
  const nl1 = buf.indexOf(0x0a);
  if (nl1 < 0 || buf.subarray(0, nl1).toString() !== 'v1') return null;
  const nl2 = buf.indexOf(0x0a, nl1 + 1);
  if (nl2 < 0) return null;
  const len = Number(buf.subarray(nl1 + 1, nl2).toString());
  if (!Number.isInteger(len) || len < 0) return null;
  const start = nl2 + 1;
  if (buf.length < start + len) return null;
  return {
    username: buf.subarray(start, start + len).toString('utf8'),
    password: buf.subarray(start + len).toString('utf8'),
  };
}

function publicKeyPem() {
  return PUBLIC_KEY;
}

/**
 * 改密载荷： "v2\n" + ulen + "\n" + username + olen + "\n" + oldPassword + newPassword
 * 两个变长字段都用长度前缀，剩余部分即 newPassword，解析无歧义。
 */
function encodeChangePayload(username, oldPassword, newPassword) {
  const ub = Buffer.from(username, 'utf8');
  const ob = Buffer.from(oldPassword, 'utf8');
  return Buffer.concat([
    Buffer.from(`v2\n${ub.length}\n`, 'utf8'),
    ub,
    Buffer.from(`${ob.length}\n`, 'utf8'),
    ob,
    Buffer.from(newPassword, 'utf8'),
  ]);
}

function decodeChangePayload(text) {
  const buf = Buffer.from(text, 'utf8');
  let pos = 0;
  const readDigits = () => {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) return null;
    const s = buf.subarray(pos, nl).toString();
    if (!/^\d+$/.test(s)) return null;
    pos = nl + 1;
    return Number(s);
  };
  const nl1 = buf.indexOf(0x0a, 0);
  if (nl1 < 0 || buf.subarray(0, nl1).toString() !== 'v2') return null;
  pos = nl1 + 1;

  const ulen = readDigits();
  if (ulen === null || buf.length < pos + ulen) return null;
  const username = buf.subarray(pos, pos + ulen).toString('utf8');
  pos += ulen;

  const olen = readDigits();
  if (olen === null || buf.length < pos + olen) return null;
  const oldPassword = buf.subarray(pos, pos + olen).toString('utf8');
  pos += olen;

  const newPassword = buf.subarray(pos).toString('utf8');
  if (!newPassword) return null;
  return { username, oldPassword, newPassword };
}

/** 仅用于演示/测试：前端会用公钥加密 */
function encryptForTest(plaintext) {
  return crypto
    .publicEncrypt(
      { key: PUBLIC_KEY, padding: config.rsa.padding, oaepHash: config.rsa.oaepHash },
      Buffer.from(plaintext, 'utf8')
    )
    .toString('base64');
}

module.exports = {
  decryptCredentials,
  encodePayload,
  decodePayload,
  encodeChangePayload,
  decodeChangePayload,
  publicKeyPem,
  encryptForTest,
  RSA_CONFIG: config.rsa,
};
