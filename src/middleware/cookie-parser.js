'use strict';
/**
 * 零依赖 Cookie 解析：把 req.headers.cookie 解析到 req.cookies。
 *
 * Express 5 不再内置 req.cookies，且项目刻意不加 cookie-parser 依赖
 * （与 cors 中间件一样保持零依赖风格），故在此手写一个最小实现。
 * token 是 base64url，本身不含需转义字符，但仍做容错解码。
 */

function decodeURIComponentSafe(val) {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponentSafe(raw);
  }
  return out;
}

function createCookieParser() {
  return function cookieParser(req, _res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    next();
  };
}

module.exports = { createCookieParser, parseCookies };
