'use strict';
/**
 * CSRF 防护：状态变更请求（非 GET/HEAD/OPTIONS）校验 Origin/Referer。
 *
 * 为什么需要：会话改走 HttpOnly Cookie 后，浏览器会自动携带 Cookie，
 * 引入 CSRF 攻击面（Bearer 头时代浏览器不会自动带 Authorization，天然免疫）。
 * 方案 §「若改 HttpOnly Cookie 必须同步补 CSRF 防护，不可只改一处」。
 * SameSite=Lax 只能挡住跨站，挡不住同站子域，因此仍需 Origin 白名单校验。
 *
 * 放行条件（满足其一）：
 *   1) 同源：Origin 的 协议+主机 与请求 Host 一致
 *      —— 同源反代 / devServer 代理场景，Origin 由浏览器自动带上且等于本站
 *   2) 白名单：Origin 落在 CORS_ORIGINS 内
 *      —— 分域直连（chat.X → api.X）场景，需显式配置前端来源
 * Origin 缺失时回退 Referer；两者都缺失则拒绝。
 *
 * 注意：Origin 是浏览器禁止脚本篡改的禁改头，CLI/curl 可任意设置但不构成 CSRF 向量
 * （CSRF 的前提是受害者浏览器自动带 Cookie，攻击者无法控制其 Origin）。
 */
const { sendError } = require('../lib/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return '';
  }
}

function createCsrf({ origins = [], enabled = true } = {}) {
  const allow = new Set(origins.map((o) => String(o).trim().toLowerCase()).filter(Boolean));
  if (!enabled) return (_req, _res, next) => next();

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    let origin = originOf(req.headers.origin);
    if (!origin) origin = originOf(req.headers.referer);
    if (!origin) return sendError(res, 'CSRF_FORBIDDEN');

    const host = String(req.get('host') || '').toLowerCase();
    const proto = String(req.protocol || 'http').toLowerCase();
    const sameOrigin = Boolean(host) && origin === `${proto}://${host}`;

    if (!sameOrigin && !allow.has(origin)) {
      return sendError(res, 'CSRF_FORBIDDEN');
    }
    return next();
  };
}

module.exports = { createCsrf };
