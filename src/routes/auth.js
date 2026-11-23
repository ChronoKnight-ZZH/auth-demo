'use strict';
/**
 * 路由（方案 §6.1 接口清单）。
 *
 * 会话凭证：HttpOnly Cookie（由本路由在登录时 Set-Cookie 下发）。
 * 鉴权中间件从 Cookie 取 token；前端不再持有 token 原文，也不再发 Authorization 头。
 * 状态变更请求由 csrf 中间件校验 Origin/Referer 白名单。
 */
const express = require('express');
const { sendError } = require('../lib/errors');
const { publicKeyPem, RSA_CONFIG } = require('../crypto/rsa');
const { hashToken } = require('../session/token');
const { config } = require('../config');

function clientIp(req) {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/**
 * 会话 Cookie 的基础属性。
 * set（res.cookie）与 clear（res.clearCookie）必须使用完全一致的属性，
 * 否则浏览器不会删除 Cookie（Domain/Path/SameSite/Secure 任一不一致即失效）。
 */
function sessionCookieOptions() {
  const opts = {
    httpOnly: true,
    path: config.cookie.path,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
  };
  if (config.cookie.domain) opts.domain = config.cookie.domain;
  return opts;
}

function setSessionCookie(res, token, expiresAt) {
  const opts = sessionCookieOptions();
  // Max-Age 取绝对过期的剩余时间，不用 idle 时间（方案定稿）
  opts.maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  res.cookie(config.cookie.name, token, opts);
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookie.name, sessionCookieOptions());
}

/** 从 Cookie 或（过渡）Authorization 头提取 token，供登出等不挂鉴权的路由使用 */
function extractToken(req) {
  const fromCookie = req.cookies && req.cookies[config.cookie.name];
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function createRoutes({ authService, authenticate }) {
  const router = express.Router();

  // GET /auth/public-key —— 运行时下发，便于密钥轮换
  router.get('/public-key', (req, res) => {
    res.json({
      publicKey: publicKeyPem(),
      algorithm: 'RSA-OAEP',
      oaepHash: RSA_CONFIG.oaepHash,
      maxPlaintextBytes: RSA_CONFIG.maxPlaintextBytes,
    });
  });

  // POST /auth/login
  router.post('/login', async (req, res) => {
    const { encrypted } = req.body || {};
    if (typeof encrypted !== 'string') return sendError(res, 'INVALID_INPUT');
    const result = await authService.login({ encrypted, ip: clientIp(req) });
    // 直接在最终响应对象上写 Set-Cookie（不要搬运 headers，避免丢失多值 Set-Cookie）
    setSessionCookie(res, result.token, result.expiresAt);
    // 响应体不再返回 token 原文；username + expiresAt 供前端立即可用
    return res.json({ username: result.username, expiresAt: result.expiresAt });
  });

  // POST /auth/logout —— 幂等：不要求先鉴权，无论会话是否有效都清 Cookie 返回 200
  router.post('/logout', async (req, res) => {
    const token = extractToken(req);
    if (token) {
      await authService.logout(hashToken(token));
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  // GET /auth/me —— 凭证验证 + 登录态恢复：前端启动时调用，刷新后知道“我是谁”
  router.get('/me', authenticate, async (req, res) => {
    const info = await authService.me(req.userId);
    if (!info) return sendError(res, 'TOKEN_INVALID');
    return res.json({
      userId: info.userId,
      username: info.username,
      expiresAt: req.sessionExpiresAt,
    });
  });

  // POST /auth/change-password
  router.post('/change-password', authenticate, async (req, res) => {
    const { encrypted } = req.body || {};
    if (typeof encrypted !== 'string') return sendError(res, 'INVALID_INPUT');
    const result = await authService.changePassword({
      userId: req.userId,
      encrypted,
    });
    // 改密递增 credential_version，全部旧会话立即失效；清 Cookie 让前端立刻退出，
    // 不必等下一次受保护请求返回 401 才感知。
    clearSessionCookie(res);
    return res.json(result);
  });

  return router;
}

module.exports = { createRoutes };
