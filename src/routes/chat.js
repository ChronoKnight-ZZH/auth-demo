'use strict';
/**
 * /v1 中转路由（时序图 ②③）。
 *
 * 路由顺序即安全顺序：authenticate 必须在任何上游动作之前，
 * 「鉴权过才推流」不是靠约定，而是靠这里没有第二条路。
 */
const express = require('express');
const { config } = require('../config');
const { sendError } = require('../lib/errors');
const { probe } = require('../stream/upstream');

/** SSE 不能被任何中间件缓冲/压缩，这里显式关闭压缩痕迹 */
function createChatRoutes({ relay, authenticate }) {
  const router = express.Router();

  // POST /v1/chat/stream —— 新开一条流；带 Last-Event-ID 或 ?cursor= 时为续推
  router.post(
    '/chat/stream',
    express.json({ limit: config.chatBodyLimit }),
    authenticate,
    async (req, res) => {
      // 关闭 Nginx/中间层缓冲；同时避免 keep-alive 空闲计时把长流掐掉
      res.setHeader('X-Accel-Buffering', 'no');
      await relay.handle(req, res);
    }
  );

  // GET /v1/chat/stream?requestId=&cursor= —— 只读续推（同一条流的第二条恢复通道）
  // 走 relay.resume：不校验 body，语义就是「把已有流从 cursor 接下去」
  router.get('/chat/stream', authenticate, async (req, res) => {
    await relay.resume(req, res);
  });

  // GET /v1/relay/stats —— 运维观察（鉴权后仅暴露聚合计数，不含内容）
  router.get('/relay/stats', authenticate, (req, res) => {
    res.json(relay.stats());
  });

  // GET /v1/models —— 上游能力探测，走服务端 Key，前端不接触 Key
  router.get('/models', authenticate, async (req, res) => {
    const r = await probe();
    if (!r.ok) return sendError(res, r.code === 'UPSTREAM_NOT_CONFIGURED' ? 'UPSTREAM_NOT_CONFIGURED' : 'UPSTREAM_ERROR');
    res.json({ ok: true, status: r.status });
  });

  return router;
}

module.exports = { createChatRoutes };
