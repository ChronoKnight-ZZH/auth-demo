'use strict';
/**
 * 账户余额查询。
 *
 *   GET /user/balance —— 用服务端上游 Key 查询账户余额，响应体原样透传：
 *     { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * 与 /v1 中转同一原则：Key 绝不出现给前端。上游 401/403 在这里折叠成
 * UPSTREAM_REJECTED(502)，不能直接返回 401 —— 否则前端会把「上游 Key 失效」
 * 误当成「用户 Token 过期」而登出。
 */
const express = require('express');
const { sendError } = require('../lib/errors');
const upstream = require('../stream/upstream');

/** UpstreamError → 本项目错误码 */
function sendUpstreamError(res, err) {
  const code = err && err.code;
  if (code === 'UPSTREAM_NOT_CONFIGURED') return sendError(res, 'UPSTREAM_NOT_CONFIGURED');
  if (code === 'UPSTREAM_TIMEOUT') return sendError(res, 'UPSTREAM_TIMEOUT');

  const status = err && err.upstreamStatus;
  if (status === 429) return sendError(res, 'UPSTREAM_RATE_LIMITED');
  if (status >= 400 && status < 500) return sendError(res, 'UPSTREAM_REJECTED');
  return sendError(res, 'UPSTREAM_ERROR');
}

function createBalanceRoutes({ authenticate }) {
  const router = express.Router();

  router.get('/user/balance', authenticate, async (req, res) => {
    // 前端断开时立刻取消上游请求，不留下无主的连接
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new Error('client closed'));
    };
    res.once('close', onClose);

    try {
      const data = await upstream.getBalance({ signal: controller.signal });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(data);
    } catch (err) {
      // 客户端已走：没有可写的响应，也不值得告警
      if (res.destroyed || res.headersSent || (err && err.code === 'ABORTED')) {
        return undefined;
      }
      console.error('[balance]', err && err.message);
      return sendUpstreamError(res, err);
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}

module.exports = { createBalanceRoutes };
