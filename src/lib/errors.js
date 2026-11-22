'use strict';
/**
 * 统一错误语义（方案 §5、§6.3）。
 * 对外只暴露稳定的 code，不泄露内部细节。
 */

const CODES = {
  INVALID_CREDENTIALS: [401, '账号或密码错误'],
  INVALID_INPUT: [400, '输入无效'],
  TOKEN_MISSING: [401, '缺少凭证'],
  TOKEN_INVALID: [401, '凭证无效'],
  TOKEN_EXPIRED: [401, '凭证已过期'],
  ACCOUNT_LOCKED: [403, '账号已被锁定'],
  TOO_MANY_ATTEMPTS: [429, '尝试过于频繁'],
  AUTH_BUSY: [429, '服务繁忙，请稍后重试'],
  SESSION_WRITE_FAILED: [503, '会话写入失败'],
  SESSION_STORE_UNAVAILABLE: [503, '会话存储不可用'],
  NOT_FOUND: [404, '资源不存在'],
  INTERNAL: [500, '服务器内部错误'],

  // ---- 中转链路（在推流开始前才能作为 HTTP 状态返回；开始推流后只能进 SSE error 帧）----
  /** 服务端未配置上游凭证 */
  UPSTREAM_NOT_CONFIGURED: [503, '上游服务未配置'],
  /** 熔断打开 */
  UPSTREAM_UNAVAILABLE: [503, '上游服务暂不可用'],
  /** 上游返回 4xx（请求本身有问题，不重试） */
  UPSTREAM_REJECTED: [502, '上游拒绝请求'],
  /** 上游返回 5xx / 网络异常（可重试类） */
  UPSTREAM_ERROR: [502, '上游服务异常'],
  /** 上游超时 */
  UPSTREAM_TIMEOUT: [504, '上游响应超时'],
  /** 上游限流 */
  UPSTREAM_RATE_LIMITED: [429, '上游限流，请稍后重试'],
  /** 请求体超过路由上限 */
  PAYLOAD_TOO_LARGE: [413, '请求体过大'],
  /** 中转并发闸满 */
  RELAY_BUSY: [429, '并发流已满，请稍后重试'],
  /** 续推游标非法（非数字等） */
  CURSOR_INVALID: [400, '续推游标无效'],
  /** 续推游标早于缓冲起点（缓冲已截断） */
  CURSOR_EXPIRED: [410, '续推游标已被截断'],
  /** 缓冲已过期（超过 TTL） */
  STREAM_EXPIRED: [410, '该回复流已结束并过期'],
  /** 请求体中的模型不在白名单 */
  MODEL_NOT_ALLOWED: [400, '模型不在允许列表'],

  // ---- 附件原件（里程碑 3）----
  /** 文件票据非法、被篡改或已过期（统一 403，不区分原因） */
  FILE_TOKEN_INVALID: [403, '文件访问票据无效'],
  /** 文件归属或会话归属不匹配（与不存在统一 404，避免探测） */
  FILE_ACCESS_DENIED: [404, '文件不存在'],
  /** 文件服务关闭 */
  FILES_DISABLED: [503, '文件服务未启用'],
};

class AppError extends Error {
  constructor(code, message) {
    super(message || (CODES[code] ? CODES[code][1] : code));
    this.code = code;
    this.status = CODES[code] ? CODES[code][0] : 500;
  }
}

function sendError(res, code, extra) {
  const [status, message] = CODES[code] || CODES.INTERNAL;
  return res.status(status).json({ code, message, ...(extra || {}) });
}

/** Express 5 原生支持 async handler 的错误传递，这里只做统一收口 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  if (err instanceof AppError) return sendError(res, err.code);
  if (err && err.code === 'AUTH_BUSY') return sendError(res, 'AUTH_BUSY');
  if (err && err.type === 'entity.too.large') return sendError(res, 'PAYLOAD_TOO_LARGE');

  // 未预期错误：日志保留堆栈，对外只给 INTERNAL
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err && err.stack ? err.stack : err);
  return sendError(res, 'INTERNAL');
}

module.exports = { CODES, AppError, sendError, errorHandler };