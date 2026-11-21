'use strict';
/**
 * SessionStore 接口 + 两个实现（Redis / 内存 Map）。
 *
 * 语义约定（方案 §6.2.3、§6.2.4、§6.4）：
 *   - set()       登录写入，必须原子地写入字段并设置空闲 TTL
 *   - get()       按 tokenHash 读取
 *   - touch()     滑动续期（节流由调用方控制）
 *   - delete()    登出/失效清理
 *   - revokeAll() 【版本失效语义】，不是遍历删除。
 *                 实现为递增用户版本号，使该用户全部旧会话在下次校验时失败。
 *
 * 两个实现必须通过同一套验收（A-U-03）。
 */

class SessionStore {
  /* eslint-disable no-unused-vars */
  async set(session) { throw new Error('not implemented'); }
  async get(tokenHash) { throw new Error('not implemented'); }
  async touch(tokenHash, idleMs) { throw new Error('not implemented'); }
  async delete(tokenHash) { throw new Error('not implemented'); }
  async getCredVersion(userId) { throw new Error('not implemented'); }
  async setCredVersion(userId, version, ttlMs) { throw new Error('not implemented'); }
  async revokeAll(userId, nextVersion) { throw new Error('not implemented'); }
  async close() {}
  /* eslint-enable no-unused-vars */
}

module.exports = { SessionStore };