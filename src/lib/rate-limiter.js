'use strict';
/**
 * 防暴力破解：双维度计数闸 + 计数必须在 argon2 之前（方案 §6.2.5）。
 * 内存实现；Redis 部署时可平移到同一接口。
 */

function createRateLimiter({ maxPerAccount, maxPerIp, windowSec }) {
  const accounts = new Map(); // key -> {count, resetAt}
  const ips = new Map();
  const windowMs = windowSec * 1000;

  function bump(map, key) {
    const now = Date.now();
    let rec = map.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      map.set(key, rec);
    }
    rec.count += 1;
    return rec;
  }

  function peek(map, key) {
    const rec = map.get(key);
    if (!rec) return 0;
    if (rec.resetAt <= Date.now()) { map.delete(key); return 0; }
    return rec.count;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of accounts) if (v.resetAt <= now) accounts.delete(k);
    for (const [k, v] of ips) if (v.resetAt <= now) ips.delete(k);
  }, 60_000).unref();

  return {
    /** 校验前调用：已达阈值则不进入 argon2 */
    isBlocked(username, ip) {
      return peek(accounts, username) >= maxPerAccount || peek(ips, ip) >= maxPerIp;
    },
    /** 失败后调用：原子递增 */
    recordFailure(username, ip) {
      bump(accounts, username);
      bump(ips, ip);
    },
    /** 成功后清除账号维度计数（IP 维度保留，防止换账号爆破） */
    recordSuccess(username) {
      accounts.delete(username);
    },
    /** 供验收观察 */
    stats() {
      return { accounts: accounts.size, ips: ips.size };
    },
  };
}

module.exports = { createRateLimiter };