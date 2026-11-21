'use strict';
/**
 * 路由（方案 §6.1 接口清单）。
 */
const express = require('express');
const { sendError } = require('../lib/errors');
const { publicKeyPem, RSA_CONFIG } = require('../crypto/rsa');

function clientIp(req) {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
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
    return res.json(result);
  });

  // POST /auth/logout —— 幂等
  router.post('/logout', authenticate, async (req, res) => {
    await authService.logout(req.tokenHash);
    return res.json({ ok: true });
  });

  // GET /auth/me —— 凭证验证 Demo 接口
  router.get('/me', authenticate, async (req, res) => {
    return res.json({ userId: req.userId });
  });

  // POST /auth/change-password
  router.post('/change-password', authenticate, async (req, res) => {
    const { encrypted } = req.body || {};
    if (typeof encrypted !== 'string') return sendError(res, 'INVALID_INPUT');
    const result = await authService.changePassword({
      userId: req.userId,
      encrypted,
    });
    return res.json(result);
  });

  return router;
}

module.exports = { createRoutes };