'use strict';
/**
 * 上游熔断器 + 重试退避（时序图 ③-A「上游重试(超时熔断/退避)」）。
 *
 * 状态机：closed →（滑动窗口失败达阈值）→ open →（冷却到期）→ half-open →（试探成功）→ closed
 *                                                        ↘（试探失败）→ open
 *
 * 只有「可重试类」失败计入熔断窗口：超时、连接错误、上游 5xx/429。
 * 上游 4xx（鉴权/参数问题）是请求自身的问题，计入成功以外的「不熔断」类别，
 * 否则一个坏请求就能把整个上游打开。
 */
const { config } = require('../config');

class CircuitBreaker {
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? config.stream.circuit.failureThreshold;
    this.windowMs = opts.windowMs ?? config.stream.circuit.windowMs;
    this.cooldownMs = opts.cooldownMs ?? config.stream.circuit.cooldownMs;
    this.state = 'closed';
    this.failures = [];      // 滑动窗口内的失败时间戳
    this.openedAt = 0;
    this.probing = false;    // half-open 时只放一个试探请求
    this.metrics = { passed: 0, rejected: 0, failures: 0, opened: 0, recovered: 0 };
  }

  /** 是否允许发起请求；half-open 时仅放行单并发试探 */
  allow() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        this.probing = false;
      } else {
        this.metrics.rejected += 1;
        return false;
      }
    }
    // half-open：单探针
    if (this.probing) { this.metrics.rejected += 1; return false; }
    this.probing = true;
    return true;
  }

  recordSuccess() {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = [];
      this.probing = false;
      this.metrics.recovered += 1;
    }
    this.metrics.passed += 1;
  }

  /**
   * 记录一次「可重试类」失败。
   * @param {Error} err 已分类的上游错误（UPSTREAM_TIMEOUT / UPSTREAM_ERROR / network）
   */
  recordFailure(err) {
    void err;
    const now = Date.now();
    this.failures.push(now);
    this.metrics.failures += 1;
    this._trim(now);
    if (this.state === 'half-open') {
      this._trip(now);
      return;
    }
    if (this.state === 'closed' && this.failures.length >= this.failureThreshold) {
      this._trip(now);
    }
  }

  _trip(now) {
    this.state = 'open';
    this.openedAt = now;
    this.probing = false;
    this.metrics.opened += 1;
  }

  _trim(now) {
    const cutoff = now - this.windowMs;
    while (this.failures.length && this.failures[0] < cutoff) this.failures.shift();
  }

  snapshot() {
    return { state: this.state, windowFailures: this.failures.length, ...this.metrics };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带退避的重试包装。
 *
 * 【关键约束】isRetryable 必须由调用方判定「尚未产出任何 token」：
 * 流一旦开始下发增量，重试会造成重复内容与重复计费，此时只能断流续推，
 * 绝不能重发上游请求。
 */
async function withRetry(fn, { maxAttempts, baseBackoffMs, maxBackoffMs, onRetry, shouldAbort } = {}) {
  const attempts = maxAttempts ?? config.stream.retry.maxAttempts;
  const base = baseBackoffMs ?? config.stream.retry.baseBackoffMs;
  const cap = maxBackoffMs ?? config.stream.retry.maxBackoffMs;
  let lastErr;
  for (let i = 0; i <= attempts; i++) {
    if (shouldAbort?.()) {
      const e = new Error('aborted before upstream attempt');
      e.code = 'ABORTED';
      throw e;
    }
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable === true && err.code !== 'ABORTED';
      if (!retryable || i === attempts) throw err;
      const backoff = Math.min(cap, base * 2 ** i);
      // 抖动：避免多实例同时重试打尖
      const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2));
      onRetry?.(i + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { CircuitBreaker, withRetry, sleep };
