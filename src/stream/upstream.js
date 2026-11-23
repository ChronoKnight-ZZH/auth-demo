'use strict';
/**
 * 上游客户端（唯一持有 API Key 的地方）。
 *
 * 三重超时，各管一件事：
 *   1) headers —— 首字节超时：上游挂了要立刻失败，不能让前端干等
 *   2) idle    —— 相邻数据块静默超时：流式最合适的判死方式（比总超时更不误杀长回复）
 *   3) total   —— 单请求总时限：封顶成本与连接占用
 *
 * 错误分类约定（上层据此决定重试 / 熔断 / 直接透传）：
 *   err.code      : UPSTREAM_TIMEOUT | UPSTREAM_ERROR | UPSTREAM_REJECTED
 *   err.retryable : 超时、网络错误、上游 5xx/429 → true；上游 4xx → false
 *   err.upstreamStatus : 上游原始状态码（诊断用，不进响应体）
 */
const { config } = require('../config');

class UpstreamError extends Error {
  constructor(code, message, { retryable = false, upstreamStatus, cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.retryable = retryable;
    this.upstreamStatus = upstreamStatus;
    if (cause) this.cause = cause;
  }
}

/** 上游状态码 → 是否值得重试（429 尊重上游，只做有限次退避重试） */
function isUpstreamRetryable(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function classifyHttpStatus(status) {
  if (isUpstreamRetryable(status)) {
    return new UpstreamError('UPSTREAM_ERROR', `upstream ${status}`, {
      retryable: true, upstreamStatus: status,
    });
  }
  return new UpstreamError('UPSTREAM_REJECTED', `upstream ${status}`, {
    retryable: false, upstreamStatus: status,
  });
}

/**
 * 发起上游流式请求，返回 { response, stop }。
 * response.body 为 Web ReadableStream；消费方必须负责 cancel/release。
 *
 * @param {object} body        已校验并强制 stream:true 的请求体
 * @param {object} opts        { signal, onFirstByte }
 * @returns {Promise<{response: Response, stop: function, noteActivity: function}>}
 */
async function openStream(body, opts = {}) {
  if (!config.upstream.apiKey) {
    const e = new UpstreamError('UPSTREAM_NOT_CONFIGURED', 'UPSTREAM_API_KEY not set', { retryable: false });
    e.appCode = 'UPSTREAM_NOT_CONFIGURED';
    throw e;
  }

  const controller = new AbortController();
  const callerSignal = opts.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });
  }

  const timers = { headers: null, total: null };
  let idleTimer = null;
  let timedOut = null;

  const failWith = (code, msg) => {
    timedOut = new UpstreamError(code, msg, { retryable: true });
    controller.abort(timedOut);
  };

  timers.headers = setTimeout(() => failWith('UPSTREAM_TIMEOUT', 'upstream headers timeout'), config.upstream.headersTimeoutMs);
  timers.total = setTimeout(() => failWith('UPSTREAM_TIMEOUT', 'upstream total timeout'), config.upstream.totalTimeoutMs);

  const clear = (t) => { if (t) clearTimeout(t); };
  const stopIdle = () => { clear(idleTimer); idleTimer = null; };

  /** 每收到一个数据块重置静默超时 */
  const noteActivity = () => {
    stopIdle();
    if (!idleTimer) {
      idleTimer = setTimeout(() => failWith('UPSTREAM_TIMEOUT', 'upstream idle timeout'), config.upstream.idleTimeoutMs);
    }
  };

  let response;
  try {
    response = await fetch(config.upstream.baseUrl + config.upstream.messagesPath, {
      method: 'POST',
      headers: {
        // Key 只出现在这一跳；任何返回前端的路径都不带它
        Authorization: `Bearer ${config.upstream.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    stopIdle(); clear(timers.headers); clear(timers.total);
    if (timedOut) throw timedOut;
    if (callerSignal?.aborted) {
      const e = new UpstreamError('ABORTED', 'client aborted', { retryable: false, cause: err });
      throw e;
    }
    throw new UpstreamError('UPSTREAM_ERROR', `upstream network error: ${err.message}`, {
      retryable: true, cause: err,
    });
  }

  stopIdle(); clear(timers.headers);
  // total 计时保留（由 stop() 清理）

  if (!response.ok) {
    const err = classifyHttpStatus(response.status);
    // 关掉上游连接，别留半开
    response.body?.cancel().catch(() => {});
    clear(timers.total);
    throw err;
  }

  const ct = response.headers.get('content-type') || '';
  if (!response.body || !ct.includes('text/event-stream')) {
    response.body?.cancel().catch(() => {});
    clear(timers.total);
    const err = new UpstreamError('UPSTREAM_ERROR', `upstream content-type "${ct}" is not event-stream`, {
      retryable: true, upstreamStatus: response.status,
    });
    throw err;
  }

  noteActivity();
  opts.onFirstByte?.();

  /** 释放全部计时与上游连接 */
  const stop = () => {
    stopIdle();
    clear(timers.headers);
    clear(timers.total);
    try { response.body?.cancel().catch(() => {}); } catch { /* 已读完 */ }
  };

  return { response, stop, noteActivity };
}

/**
 * GET /user/balance：查询账户余额（只读、不产生费用）。
 *
 * 失败一律转成 UpstreamError：上游 401/403 不能被前端误判为「自己的 Token 失效」，
 * 路由层据 err.code / err.upstreamStatus 映射成本项目的错误码。
 *
 * @param {object} opts { signal }
 * @returns {Promise<object>} 上游 GetUserBalanceResponse 原样 JSON
 */
async function getBalance(opts = {}) {
  if (!config.upstream.apiKey) {
    const e = new UpstreamError('UPSTREAM_NOT_CONFIGURED', 'UPSTREAM_API_KEY not set', { retryable: false });
    e.appCode = 'UPSTREAM_NOT_CONFIGURED';
    throw e;
  }

  const controller = new AbortController();
  const callerSignal = opts.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });
  }

  let timedOut = null;
  const timer = setTimeout(() => {
    timedOut = new UpstreamError('UPSTREAM_TIMEOUT', 'upstream balance timeout', { retryable: true });
    controller.abort(timedOut);
  }, config.upstream.balanceTimeoutMs);
  timer.unref?.();

  let response;
  try {
    response = await fetch(config.upstream.baseUrl + config.upstream.balancePath, {
      method: 'GET',
      headers: {
        // Key 只出现在这一跳；响应体只有余额字段
        Authorization: `Bearer ${config.upstream.apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw timedOut;
    if (callerSignal?.aborted) {
      throw new UpstreamError('ABORTED', 'client aborted', { retryable: false, cause: err });
    }
    throw new UpstreamError('UPSTREAM_ERROR', `upstream network error: ${err.message}`, {
      retryable: true, cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw classifyHttpStatus(response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new UpstreamError('UPSTREAM_ERROR', 'upstream balance is not valid json', {
      retryable: false, upstreamStatus: response.status, cause: err,
    });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new UpstreamError('UPSTREAM_ERROR', 'upstream balance has unexpected shape', {
      retryable: false, upstreamStatus: response.status,
    });
  }
  return data;
}

/** GET /models：不产生费用的连通性探测（健康检查用） */
async function probe(opts = {}) {
  if (!config.upstream.apiKey) {
    return { ok: false, code: 'UPSTREAM_NOT_CONFIGURED' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstream.headersTimeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(config.upstream.baseUrl + config.upstream.modelsPath, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.upstream.apiKey}` },
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, code: 'UPSTREAM_ERROR', message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { UpstreamError, openStream, probe, getBalance, isUpstreamRetryable };
