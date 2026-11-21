'use strict';
/**
 * 内存 EventBuffer —— 零依赖实现（同时作为 A-U-03 式「第二实现」）。
 * 语义必须与 RedisStreamBuffer 严格一致，前端不感知差异。
 */
const { EventBuffer, notifyAppended } = require('./event-buffer');
const { config } = require('../config');

class MemoryEventBuffer extends EventBuffer {
  constructor(opts = {}) {
    super();
    this.maxEvents = opts.maxEvents || config.stream.bufferMaxEvents;
    this.maxBytes = opts.maxBytes || config.stream.bufferMaxBytes;
    this.ttlMs = opts.ttlMs || config.stream.bufferTtlMs;
    /** streamId -> { meta, frames: [{id,event,data}], bytes, expiresAt } */
    this.streams = new Map();
    this.sweeper = setInterval(() => this._sweep(), 30_000);
    this.sweeper.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.streams) {
      if (v.expiresAt <= now) this.streams.delete(k);
    }
  }

  _touch(rec) {
    rec.expiresAt = Date.now() + this.ttlMs;
  }

  /** 内部：取未过期记录，过期即删 */
  _peek(streamId) {
    const rec = this.streams.get(streamId);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) {
      this.streams.delete(streamId);
      return null;
    }
    return rec;
  }

  async ping() { return 'PONG'; }

  async create(streamId, meta) {
    const now = Date.now();
    const rec = {
      meta: {
        ...meta,
        status: 'inflight',
        createdAt: now,
        finishedAt: 0,
        count: 0,        // 已分配的最大 id
        firstId: 1,      // 当前缓冲头部事件的 id
        bytes: 0,
      },
      frames: [],
      bytes: 0,
      expiresAt: now + this.ttlMs,
    };
    // 幂等：同 id 重复 create 不覆盖已有缓冲
    if (!this.streams.has(streamId) || this._peek(streamId) === null) {
      this.streams.set(streamId, rec);
    }
    return { ...this.streams.get(streamId).meta };
  }

  async getState(streamId) {
    const rec = this._peek(streamId);
    return rec ? { ...rec.meta } : null;
  }

  async append(streamId, frame) {
    const rec = this._peek(streamId);
    if (!rec) return null; // 流已被清理，丢弃（生产者会因 state 检查退出）
    const id = rec.meta.count + 1;
    rec.meta.count = id;
    const entry = { id, event: frame.event || 'message', data: frame.data };
    rec.frames.push(entry);
    const size = Buffer.byteLength(entry.data) + entry.event.length + 16;
    rec.bytes += size;
    rec.meta.bytes = rec.bytes;

    // 双上限截断：只从头丢弃，保证 id → 下标映射连续
    while (
      (rec.frames.length > this.maxEvents || rec.bytes > this.maxBytes) &&
      rec.frames.length > 1
    ) {
      const dropped = rec.frames.shift();
      rec.bytes -= Buffer.byteLength(dropped.data) + dropped.event.length + 16;
      rec.meta.firstId = rec.frames[0].id;
    }
    rec.meta.bytes = rec.bytes;
    this._touch(rec);
    notifyAppended(streamId, rec.meta.firstId);
    return { id, firstId: rec.meta.firstId };
  }

  async read(streamId, afterId, limit) {
    const rec = this._peek(streamId);
    if (!rec) return null;
    const firstId = rec.meta.firstId;
    const truncated = afterId < firstId - 1;
    const start = Math.max(0, afterId - firstId + 1);
    const items = rec.frames.slice(start, start + (limit > 0 ? limit : 500));
    this._touch(rec);
    return { items, firstId, count: rec.meta.count, truncated };
  }

  async finish(streamId, status, extra = {}) {
    const rec = this._peek(streamId);
    if (!rec) return null;
    rec.meta.status = status;
    rec.meta.finishedAt = Date.now();
    if (extra.errorCode) rec.meta.errorCode = extra.errorCode;
    if (extra.finishReason) rec.meta.finishReason = extra.finishReason;
    this._touch(rec);
    notifyAppended(streamId, rec.meta.firstId);
    return { ...rec.meta };
  }

  async close() {
    clearInterval(this.sweeper);
    this.streams.clear();
  }
}

module.exports = { MemoryEventBuffer };
