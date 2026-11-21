'use strict';
/**
 * 响应缓存层：命中即整段回放（仍走 SSE，仍具备续推能力）。
 *
 * 键设计（安全优先）：
 *   cacheKey = sha256(userId \n model \n bodyHash)
 *   —— 默认含 userId，即使用户提交了完全相同的消息也不会读到他人响应。
 *   CACHE_CROSS_USER=1 才去掉 userId（公共模板问答等显式场景），启动自检会打警告。
 *
 * 只缓存「正常跑完且有产出」的流（status=done）；错误流、被中断流不写缓存，
 * 否则会把一次上游抖动的残片固化成 TTL 内的稳定错误。
 */
const crypto = require('node:crypto');
const { config } = require('../config');

function normalizeBody(body) {
  // 只保留会影响结果的字段；stream 恒为 true，客户端生成的 id 等不参与
  return JSON.stringify({
    model: body.model,
    messages: body.messages,
    system: body.system ?? null,
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    thinking: body.thinking ?? null,
    tools: body.tools ?? null,
    stream: true,
  });
}

function makeCacheKey(userId, body) {
  const scope = config.cache.crossUser ? 'x' : String(userId);
  const h = crypto.createHash('sha256');
  h.update(scope);
  h.update('\n');
  h.update(normalizeBody(body));
  return `cache:${h.digest('hex')}`;
}

class MemoryResponseCache {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || config.cache.ttlMs;
    this.maxEntryBytes = opts.maxEntryBytes || config.cache.maxEntryBytes;
    this.entries = new Map(); // key -> { value, expiresAt }
    this.sweeper = setInterval(() => this._sweep(), 60_000);
    this.sweeper.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
  }

  async get(key) {
    const rec = this.entries.get(key);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) { this.entries.delete(key); return null; }
    return rec.value;
  }

  async set(key, value) {
    const size = value.bytes || 0;
    if (size > this.maxEntryBytes) return false;
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return true;
  }

  async close() { clearInterval(this.sweeper); this.entries.clear(); }
}

class RedisResponseCache {
  constructor(url, opts = {}) {
    const Redis = require('ioredis');
    this.redis = new Redis(url || config.redis.url, { maxRetriesPerRequest: 2 });
    this.ttlMs = opts.ttlMs || config.cache.ttlMs;
    this.maxEntryBytes = opts.maxEntryBytes || config.cache.maxEntryBytes;
  }

  async get(key) {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async set(key, value) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > this.maxEntryBytes) return false;
    await this.redis.set(key, raw, 'PX', String(this.ttlMs));
    return true;
  }

  async close() { await this.redis.quit(); }
}

function createResponseCache(useRedis) {
  if (useRedis) return new RedisResponseCache();
  return new MemoryResponseCache();
}

module.exports = { makeCacheKey, normalizeBody, createResponseCache, MemoryResponseCache, RedisResponseCache };
