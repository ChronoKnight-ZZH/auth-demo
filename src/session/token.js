'use strict';
/**
 * Opaque Token 生成与哈希。
 * 对应方案 §6.2.3。
 */
const crypto = require('node:crypto');

/** 32 字节熵，base64url 后约 43 字符 */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Session 存储只存该哈希，不存原文 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateToken, hashToken };