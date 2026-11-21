'use strict';
/**
 * Redis SessionStore —— 生产/Demo 默认实现。
 * 对应方案 §6.2.3 的 LOGIN_LUA（唯一权威实现）。
 */
const Redis = require('ioredis');
const { SessionStore } = require('./store');
const { config } = require('../config');

// 登录写入：单条 Lua 完成 HSET + PEXPIRE，避免「Key 存在但无过期」窗口。
// ARGV 契约：userId, credver, status, idleTtlMs, absoluteExpiresAtMs, createdAtMs
const LOGIN_LUA = `
local key = 'session:' .. KEYS[1]
redis.call('HSET', key,
  'userId', ARGV[1],
  'credver', ARGV[2],
  'status', ARGV[3],
  'absoluteExpiresAt', ARGV[5],
  'createdAt', ARGV[6])
redis.call('PEXPIRE', key, ARGV[4])
return 1
`;

// 滑动续期：只续空闲 TTL，且仅在仍存在时执行
const TOUCH_LUA = `
local key = 'session:' .. KEYS[1]
if redis.call('EXISTS', key) == 0 then return 0 end
redis.call('PEXPIRE', key, ARGV[1])
redis.call('HSET', key, 'lastTouchAt', ARGV[2])
return 1
`;

class RedisSessionStore extends SessionStore {
  constructor(url) {
    super();
    this.redis = new Redis(url || config.redis.url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
      lazyConnect: false,
    });
  }

  async ping() {
    return this.redis.ping();
  }

  async set({ tokenHash, userId, credver, status, idleMs, absoluteExpiresAt, createdAt }) {
    await this.redis.eval(
      LOGIN_LUA, 1, tokenHash,
      String(userId), String(credver), String(status),
      String(idleMs), String(absoluteExpiresAt), String(createdAt)
    );
  }

  async get(tokenHash) {
    const data = await this.redis.hgetall(`session:${tokenHash}`);
    if (!data || !data.userId) return null;
    return {
      userId: data.userId,
      credver: Number(data.credver),
      status: data.status,
      absoluteExpiresAt: Number(data.absoluteExpiresAt),
      createdAt: Number(data.createdAt),
      lastTouchAt: Number(data.lastTouchAt || 0),
    };
  }

  async touch(tokenHash, idleMs) {
    await this.redis.eval(TOUCH_LUA, 1, tokenHash, String(idleMs), String(Date.now()));
  }

  async delete(tokenHash) {
    await this.redis.del(`session:${tokenHash}`);
  }

  async getCredVersion(userId) {
    const v = await this.redis.get(`credver:${userId}`);
    return v === null ? null : Number(v);
  }

  async setCredVersion(userId, version, ttlMs) {
    await this.redis.set(`credver:${userId}`, String(version), 'PX', String(ttlMs));
  }

  /**
   * 版本失效：一次写即可让该用户全部旧会话失效。
   * 不需要 SCAN / KEYS 遍历，因此耗时与会话数无关（验收 A-S-11）。
   */
  async revokeAll(userId, nextVersion) {
    await this.redis.set(
      `credver:${userId}`, String(nextVersion),
      'PX', String(config.session.absoluteMs)
    );
  }

  async close() {
    await this.redis.quit();
  }
}

module.exports = { RedisSessionStore, LOGIN_LUA, TOUCH_LUA };