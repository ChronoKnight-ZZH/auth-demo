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
 * HTTPS 支持：
 *   - 目标为 https 时自动走 TLS；本地自签名证书需设 TLS_INSECURE=1 放行校验
 *     （仅影响本脚本的请求，不会改全局 NODE_TLS_REJECT_UNAUTHORIZED）。
 *
 * 注：Node 的 fetch（undici）允许设置 origin/cookie 头（与浏览器不同），
 * 故 createFetcher 可行；浏览器侧仍由真实浏览器自动处理 Cookie 与禁改 Origin。
 */
const http = require('node:http');
const https = require('node:https');

/** 是否放行自签名证书（本地 HTTPS 联调用） */
const INSECURE_TLS =
  process.env.TLS_INSECURE === '1' ||
  process.env.TLS_INSECURE === 'true' ||
  process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

/**
 * 回环地址（localhost / 127.0.0.0/8 / ::1）默认放行自签证书：
 * 本地 HTTPS 联调用的就是自签证书，脚本无需额外配置即可跑通。
 * 非回环地址必须显式 TLS_INSECURE=1 才放行。
 */
function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 放行自签时用的 undici dispatcher（惰性创建，仅 https + 放行时才需要） */
let insecureDispatcher = null;
function getInsecureDispatcher() {
  if (insecureDispatcher) return insecureDispatcher;
  const undici = require('undici');
  insecureDispatcher = new undici.Agent({ connect: { rejectUnauthorized: false } });
  return insecureDispatcher;
}

/**
 * 按目标地址选择 fetch 实现：
 *   https + （回环地址 或 显式 TLS_INSECURE=1）→ undici，关闭证书校验（本地自签证书）；
 *   其余 → 原生 fetch（正常校验证书）。
 * 注意：原生 fetch 不接受 dispatcher，放行自签证书只能用 undici 的 fetch。
 */
async function fetchTarget(target, init = {}) {
  if (target.startsWith('https://') && (INSECURE_TLS || isLoopback(new URL(target).hostname))) {
    const undici = require('undici');
    return undici.fetch(target, { ...init, dispatcher: getInsecureDispatcher() });
  }
  return fetch(target, init);
}

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
          // 本地自签名证书：回环地址默认放行，其他地址需显式 TLS_INSECURE=1
          ...(url.protocol === 'https:' ? { rejectUnauthorized: !(INSECURE_TLS || isLoopback(url.hostname)) } : {}),
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
    const target = base + path;
    const res = await fetchTarget(target, { ...init, headers });
    capture(res);
    return res;
  };

  return { fetch: doFetch, jar, origin, base, capture };
}

module.exports = { createClient, createFetcher, fetchTarget };
