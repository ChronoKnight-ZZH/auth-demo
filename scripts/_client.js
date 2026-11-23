'use strict';
/**
 * 冒烟/验收脚本共享的 HTTP 客户端：自带 Cookie Jar + Origin 头。
 *
 * 会话改走 HttpOnly Cookie 后，状态变更请求必须带 Origin 通过 CSRF 校验，
 * 且登录后的 Set-Cookie 要在后续请求自动携带（模拟浏览器）。
 *
 * 提供两种形态：
 *   - createClient：基于 node:http/https 的简单 call()，返回 {status,body,headers,text}。
 *   - createFetcher：fetch 包装器，保留流式响应 / Headers API（供 SSE 脚本用），
 *     自动注入 Origin + Cookie Jar、捕获响应 Set-Cookie。
 *
 * 注：Node 的 fetch（undici）允许设置 origin/cookie 头（与浏览器不同），
 * 故 createFetcher 可行；浏览器侧仍由真实浏览器自动处理 Cookie 与禁改 Origin。
 */
const http = require('node:http');
const https = require('node:https');

function createClient(base) {
  const origin = new URL(base).origin;
  const jar = Object.create(null);

  const cookieHeader = () =>
    Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  const mergeSetCookie = (headers) => {
    const list = headers['set-cookie'];
    if (!Array.isArray(list)) return;
    for (const sc of list) {
      const first = sc.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      const lower = sc.toLowerCase();
      const expired =
        /max-age=0\b/.test(lower) ||
        (/expires=/.test(lower) && /(1970|1969)/.test(lower));
      if (expired || value === '') delete jar[name];
      else jar[name] = value;
    }
  };

  const call = (method, path, { body, token, headers: extra, raw } = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(base + path);
      const lib = url.protocol === 'https:' ? https : http;
      const headers = {
        'content-type': 'application/json',
        origin,
        ...(extra || {}),
      };
      const ck = cookieHeader();
      if (ck) headers.cookie = ck;
      if (token) headers.authorization = `Bearer ${token}`;
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      if (bodyStr !== undefined) {
        headers['content-length'] = Buffer.byteLength(bodyStr);
      }
      const req = lib.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers,
        },
        (res) => {
          mergeSetCookie(res.headers);
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body = null;
            if (text) {
              try { body = JSON.parse(text); } catch { /* 非 JSON */ }
            }
            resolve({ status: res.statusCode, body, headers: res.headers, text });
          });
        }
      );
      req.on('error', reject);
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });

  return { call, origin, jar };
}

/** 解析单条 Set-Cookie，更新 jar（过期/空值则删除） */
function applySetCookie(jar, sc) {
  const first = sc.split(';')[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  const lower = sc.toLowerCase();
  const expired =
    /max-age=0\b/.test(lower) ||
    (/expires=/.test(lower) && /(1970|1969)/.test(lower));
  if (expired || value === '') delete jar[name];
  else jar[name] = value;
}

/**
 * fetch 包装器：自动注入 Origin（脚本未显式设置时）+ Cookie Jar，
 * 并在每次响应后捕获 Set-Cookie 更新 Jar。返回原生 fetch Response，
 * 因此调用方可继续用 res.json() / res.body 流 / res.headers.get()。
 */
function createFetcher(base) {
  const origin = new URL(base).origin;
  const jar = Object.create(null);

  const cookieHeader = () =>
    Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  const capture = (res) => {
    let list = [];
    try {
      if (typeof res.headers.getSetCookie === 'function') {
        list = res.headers.getSetCookie();
      }
    } catch { /* ignore */ }
    if (!list.length) {
      const raw = res.headers.get('set-cookie');
      if (raw) list = raw.split(/,(?=\s*[^;=\s]+=)/);
    }
    for (const sc of list) applySetCookie(jar, sc);
  };

  const doFetch = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!headers.has('origin')) headers.set('origin', origin);
    const ck = cookieHeader();
    if (ck && !headers.has('cookie')) headers.set('cookie', ck);
    const res = await fetch(base + path, { ...init, headers });
    capture(res);
    return res;
  };

  return { fetch: doFetch, jar, origin, base, capture };
}

module.exports = { createClient, createFetcher };
