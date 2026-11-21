'use strict';
/**
 * Redis EventBuffer —— 生产实现（多实例共享续推缓冲的唯一真相源）。
 *
 * 键布局：
 *   stream:{id}     Hash  meta（count/firstId/bytes/status/userId/bodyHash/…）
 *   stream:{id}:f   List  帧序列（JSON），与 meta 同步 TTL
 *
 * 为什么用 List 而不是 Stream：
 *   续推语义只需要「按序号随机读取 + 双上限从头截断」，List 的 LTRIM 可直接实现截断；
 *   XADD 无法廉价地限制条目数（XTRIM 只按 MAXLEN 粗裁，且拿不到被裁后的首个 id）。
 *
 * 截断策略：
 *   事件数超限 —— 精确 LTRIM 到最近 maxEvents 条；
 *   字节超限   —— 粗粒度回收头部一半，再按保留帧重算字节（摊还近似 O(1)， Rare 路径允许 O(n)）。
 *   两种截断都只从头发生，因此 firstId → 下标的映射保持连续（read 依赖它）。
 */
const Redis = require('ioredis');
const { EventBuffer, notifyAppended } = require('./event-buffer');
const { config } = require('../config');

// ARGV: event, data, maxEvents, maxBytes, ttlMs
// 序号在脚本内分配（HINCRBY），帧内容由 cjson 组装，因此 id 与 RPUSH 天然原子，
// 并发生产者不会拿到重复或错位的 id。
const APPEND_LUA = `
local mk = 'stream:' .. KEYS[1]
local lk = mk .. ':f'
if redis.call('EXISTS', mk) == 0 then return nil end
local id = redis.call('HINCRBY', mk, 'count', 1)
local payload = cjson.encode({ id = id, event = ARGV[1], data = ARGV[2] })
redis.call('RPUSH', lk, payload)
local bytes = redis.call('HINCRBY', mk, 'bytes', string.len(payload))
local n = redis.call('LLEN', lk)
local maxev = tonumber(ARGV[3])
local maxb = tonumber(ARGV[4])
if n > maxev then redis.call('LTRIM', lk, n - maxev, -1) end
if bytes > maxb then
  local keep = math.floor(redis.call('LLEN', lk) / 2)
  if keep >= 1 then redis.call('LTRIM', lk, -keep, -1) end
  local items = redis.call('LRANGE', lk, 0, -1)
  local total = 0
  for i = 1, #items do total = total + string.len(items[i]) end
  redis.call('HSET', mk, 'bytes', total)
  bytes = total
end
local head = redis.call('LINDEX', lk, 0)
local firstId = id
if head then firstId = tonumber(cjson.decode(head)['id']) end
redis.call('HSET', mk, 'firstId', firstId)
redis.call('PEXPIRE', mk, ARGV[5])
redis.call('PEXPIRE', lk, ARGV[5])
return {id, firstId, bytes}
`;

// ARGV: afterId, limit, ttlMs
const READ_LUA = `
local mk = 'stream:' .. KEYS[1]
local lk = mk .. ':f'
if redis.call('EXISTS', mk) == 0 then return nil end
local firstId = tonumber(redis.call('HGET', mk, 'firstId') or '1')
local count = tonumber(redis.call('HGET', mk, 'count') or '0')
local afterId = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local start = afterId - firstId + 1
if start < 0 then start = 0 end
local items = redis.call('LRANGE', lk, start, start + limit - 1)
redis.call('PEXPIRE', mk, ARGV[3])
redis.call('PEXPIRE', lk, ARGV[3])
local truncated = 0
if afterId < firstId - 1 then truncated = 1 end
return {firstId, count, truncated, items}
`;

// ARGV: status, finishedAt, errorCode, finishReason, ttlMs
const FINISH_LUA = `
local mk = 'stream:' .. KEYS[1]
local lk = mk .. ':f'
if redis.call('EXISTS', mk) == 0 then return 0 end
redis.call('HSET', mk, 'status', ARGV[1], 'finishedAt', ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', mk, 'errorCode', ARGV[3]) end
if ARGV[4] ~= '' then redis.call('HSET', mk, 'finishReason', ARGV[4]) end
redis.call('PEXPIRE', mk, ARGV[5])
redis.call('PEXPIRE', lk, ARGV[5])
return 1
`;

// ARGV: userId, bodyHash, requestId, createdAt, ttlMs
const CREATE_LUA = `
local mk = 'stream:' .. KEYS[1]
if redis.call('EXISTS', mk) == 1 then
  return redis.call('HGETALL', mk)
end
redis.call('HSET', mk,
  'userId', ARGV[1], 'bodyHash', ARGV[2], 'requestId', ARGV[3],
  'createdAt', ARGV[4], 'finishedAt', '0',
  'status', 'inflight', 'count', '0', 'firstId', '1', 'bytes', '0')
redis.call('PEXPIRE', mk, ARGV[5])
return redis.call('HGETALL', mk)
`;

class RedisStreamBuffer extends EventBuffer {
  constructor(url, opts = {}) {
    super();
    this.redis = new Redis(url || config.redis.url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    this.maxEvents = opts.maxEvents || config.stream.bufferMaxEvents;
    this.maxBytes = opts.maxBytes || config.stream.bufferMaxBytes;
    this.ttlMs = opts.ttlMs || config.stream.bufferTtlMs;
  }

  async ping() { return this.redis.ping(); }

  async create(streamId, meta) {
    const raw = await this.redis.eval(
      CREATE_LUA, 1, streamId,
      String(meta.userId), String(meta.bodyHash), String(meta.requestId),
      String(Date.now()), String(this.ttlMs)
    );
    return parseMeta(Array.isArray(raw) ? fromFlatArray(raw) : raw);
  }

  async getState(streamId) {
    const raw = await this.redis.hgetall(`stream:${streamId}`);
    if (!raw || !raw.userId) return null;
    return parseMeta(raw);
  }

  async append(streamId, frame) {
    const res = await this.redis.eval(
      APPEND_LUA, 1, streamId,
      String(frame.event || 'message'), String(frame.data === undefined ? '' : frame.data),
      String(this.maxEvents), String(this.maxBytes), String(this.ttlMs)
    );
    if (!res) return null; // meta 已过期/被清理
    notifyAppended(streamId, Number(res[1]));
    return { id: Number(res[0]), firstId: Number(res[1]), bytes: Number(res[2]) };
  }

  async read(streamId, afterId, limit) {
    const res = await this.redis.eval(
      READ_LUA, 1, streamId, String(afterId), String(limit > 0 ? limit : 500), String(this.ttlMs)
    );
    if (!res) return null;
    const items = (res[3] || []).map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
    notifyAppended(streamId, Number(res[0])); // 让本地 tail 立刻重查
    return {
      firstId: Number(res[0]),
      count: Number(res[1]),
      truncated: Number(res[2]) === 1,
      items,
    };
  }

  async finish(streamId, status, extra = {}) {
    const ok = await this.redis.eval(
      FINISH_LUA, 1, streamId, status, String(Date.now()),
      String(extra.errorCode || ''), String(extra.finishReason || ''), String(this.ttlMs)
    );
    notifyAppended(streamId, 1);
    return ok === 1 ? await this.getState(streamId) : null;
  }

  async close() { await this.redis.quit(); }
}

function fromFlatArray(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}

function parseMeta(raw) {
  return {
    userId: raw.userId,
    bodyHash: raw.bodyHash,
    requestId: raw.requestId,
    status: raw.status,
    count: Number(raw.count || 0),
    firstId: Number(raw.firstId || 1),
    bytes: Number(raw.bytes || 0),
    createdAt: Number(raw.createdAt || 0),
    finishedAt: Number(raw.finishedAt || 0),
    errorCode: raw.errorCode || undefined,
    finishReason: raw.finishReason || undefined,
  };
}

module.exports = { RedisStreamBuffer, APPEND_LUA, READ_LUA, FINISH_LUA, CREATE_LUA };
