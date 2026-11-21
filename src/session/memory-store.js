'use strict';
/**
 * 内存 SessionStore —— 零依赖演示实现，同时充当 A-U-03 的「第二实现」。
 * 语义必须与 RedisSessionStore 完全一致（尤其 revokeAll 是版本失效而非遍历删除）。
 */
const { SessionStore } = require('./store');

class MemorySessionStore extends SessionStore {
  constructor() {
    super();
    this.sessions = new Map();  // tokenHash -> {data, expiresAt}
    this.credvers = new Map();  // userId -> {version, expiresAt}
    this.sweeper = setInterval(() => this._sweep(), 60_000);
    this.sweeper.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.sessions) if (v.expiresAt <= now) this.sessions.delete(k);
    for (const [k, v] of this.credvers) if (v.expiresAt <= now) this.credvers.delete(k);
  }

  async ping() { return 'PONG'; }

  async set({ tokenHash, userId, credver, status, idleMs, absoluteExpiresAt, createdAt }) {
    this.sessions.set(tokenHash, {
      data: { userId, credver, status, absoluteExpiresAt, createdAt, lastTouchAt: 0 },
      expiresAt: Date.now() + idleMs,
    });
  }

  async get(tokenHash) {
    const rec = this.sessions.get(tokenHash);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) { this.sessions.delete(tokenHash); return null; }
    return { ...rec.data };
  }

  async touch(tokenHash, idleMs) {
    const rec = this.sessions.get(tokenHash);
    if (!rec) return;
    rec.expiresAt = Date.now() + idleMs;
    rec.data.lastTouchAt = Date.now();
  }

  async delete(tokenHash) { this.sessions.delete(tokenHash); }

  async getCredVersion(userId) {
    const rec = this.credvers.get(userId);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) { this.credvers.delete(userId); return null; }
    return rec.version;
  }

  async setCredVersion(userId, version, ttlMs) {
    this.credvers.set(userId, { version, expiresAt: Date.now() + ttlMs });
  }

  /**
   * 版本失效语义，与 Redis 实现严格一致。
   * 【刻意不删除会话对象】—— 否则旧会话会因「被删除」而失效，
   * 从而掩盖版本比对逻辑本身的缺陷。撤销必须只靠版本号。
   */
  async revokeAll(userId, nextVersion) {
    this.credvers.set(userId, { version: nextVersion, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 });
  }

  async close() { clearInterval(this.sweeper); }
}

module.exports = { MemorySessionStore };