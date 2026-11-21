'use strict';
/**
 * 认证中间件（方案 §6.2.4）。
 * 关键点：
 *   1) Redis 不可用 → 503，绝不返回 401（避免误导客户端登出）
 *   2) 版本校验 + status 校验在此生效（撤销与锁定）
 *   3) 滑动 TTL 节流，避免每请求写存储
 */
const { sendError } = require('../lib/errors');
const { hashToken } = require('../session/token');
const { config } = require('../config');

function createAuthenticate(sessionStore) {
  return async function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return sendError(res, 'TOKEN_MISSING');
    const token = header.slice(7).trim();
    if (!token) return sendError(res, 'TOKEN_MISSING');

    const tokenHash = hashToken(token);

    let session, credver;
    try {
      session = await sessionStore.get(tokenHash);
      if (!session) return sendError(res, 'TOKEN_INVALID');
      credver = await sessionStore.getCredVersion(session.userId);
    } catch (e) {
      // 存储故障 ≠ 凭证无效
      // eslint-disable-next-line no-console
      console.error('[session-store]', e.message);
      return sendError(res, 'SESSION_STORE_UNAVAILABLE');
    }

    if (Date.now() > session.absoluteExpiresAt) {
      await sessionStore.delete(tokenHash).catch(() => {});
      return sendError(res, 'TOKEN_EXPIRED');
    }

    // 版本失效：改密后旧会话在此被拒
    // 注意：credver 为 null 表示版本键丢失（Redis 重启且无 AOF），
    // 此处选择「放行并告警」，对应方案 §2.2 N-07 的显式声明。
    if (credver !== null && Number(credver) !== Number(session.credver)) {
      await sessionStore.delete(tokenHash).catch(() => {});
      return sendError(res, 'TOKEN_INVALID');
    }

    // 锁定生效
    if (session.status !== 'active') return sendError(res, 'ACCOUNT_LOCKED');

    // 滑动续期：节流，避免每请求写存储
    const now = Date.now();
    if (now - session.lastTouchAt >= config.session.touchThrottleMs) {
      sessionStore.touch(tokenHash, config.session.idleMs).catch(() => {});
    }

    req.userId = session.userId;
    req.tokenHash = tokenHash;
    /**
     * 供长连接（SSE）自行维持会话：一条流可能跑过空闲窗口，
     * 若期间不续期，重连续推会被判定为「凭证失效」，属于误伤。
     * 同样受节流约束，不会把存储写爆。
     */
    let lastTouch = now;
    req.touchSession = () => {
      const t = Date.now();
      if (t - lastTouch < config.session.touchThrottleMs) return;
      lastTouch = t;
      sessionStore.touch(tokenHash, config.session.idleMs).catch(() => {});
    };
    return next();
  };
}

module.exports = { createAuthenticate };