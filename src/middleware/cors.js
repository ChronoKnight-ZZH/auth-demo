'use strict';
/**
 * CORS 中间件：仅在前后端分域部署时需要（前端 chat. 直连后端 api.）。
 * 零依赖实现，配合 express 5。
 *
 * 规则：
 * - CORS_ORIGINS 未配置（空）：同源反代部署，完全不加头，行为与之前一致。
 * - 请求带 Origin 且在白名单内：回显该 Origin + Allow-Credentials，并暴露 Retry-After。
 * - CORS_ORIGINS 含 `*`：反射任意 Origin（鉴权靠 Bearer Token 头，不依赖 Cookie，
 *   反射不带来 CSRF 会话风险；生产仍建议写显式白名单）。
 * - Origin 不在白名单：不加任何 CORS 头，浏览器自行拦截（OPTIONS 直接 403）。
 * - 无 Origin（同源请求、curl、健康检查、<img> 加载）：不加头，请求正常处理。
 */

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
/** 前端实际会发送的自定义请求头；预检 Allow-Headers 给全量，避免逐头协商 */
const ALLOW_HEADERS = 'Authorization, Content-Type, Accept, X-Request-Id, X-File-Name, X-File-Mime';
/** 跨域时前端 JS 需要读取的非安全响应头 */
const EXPOSE_HEADERS = 'Retry-After, Content-Type';

function createCors({ origins = [], maxAgeSec = 600 } = {}) {
  const allow = new Set(origins.map((o) => String(o).trim().toLowerCase()).filter(Boolean));
  const allowAll = allow.has('*');
  if (allow.size === 0) {
    // 未配置：视为同源部署，不产生任何跨域行为
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();

    const lower = origin.toLowerCase();
    const permitted = allowAll || allow.has(lower);

    if (!permitted) {
      // 非白名单来源：不下发 CORS 头。预检直接拒；普通请求交给后续路由，由浏览器拦截。
      if (req.method === 'OPTIONS') {
        return res.status(403).json({ code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed' });
      }
      return next();
    }

    // 反射具体 Origin（而不是 *）：前端 credentials=include 时浏览器要求
    // Allow-Origin 必须是具体来源，Allow-Credentials 才会生效
    res.setHeader('Access-Control-Allow-Origin', lower);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', String(maxAgeSec));
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { createCors };
