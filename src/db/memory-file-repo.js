'use strict';
/**
 * 内存 FileRepo：零依赖模式与测试用，语义与 MySQL 实现保持一致。
 */

const { FileRepo } = require('./file-repo');

const clone = (value) => ({ ...value });

class MemoryFileRepo extends FileRepo {
  constructor() {
    super();
    /** userId -> Map<fileId, file> */
    this.files = new Map();
    /** `${userId}:${sessionId}` -> Set<fileId> */
    this.refs = new Map();
  }

  async ping() { return true; }

  _map(userId) {
    const key = String(userId);
    let map = this.files.get(key);
    if (!map) {
      map = new Map();
      this.files.set(key, map);
    }
    return map;
  }

  async create(userId, file) {
    const map = this._map(userId);
    for (const existing of map.values()) {
      if (!existing.deletedAt && existing.sha256 === file.sha256) {
        return clone(existing);
      }
    }
    const row = { ...file, deletedAt: null };
    map.set(row.id, row);
    return clone(row);
  }

  async get(userId, id) {
    const file = this._map(userId).get(id);
    return file && !file.deletedAt ? clone(file) : null;
  }

  async softDelete(userId, id) {
    const file = this._map(userId).get(id);
    if (!file || file.deletedAt) return false;
    file.deletedAt = Date.now();
    return true;
  }

  async syncRefs(userId, sessionId, fileIds) {
    const key = `${userId}:${sessionId}`;
    const map = this._map(userId);
    const valid = new Set(
      [...new Set(fileIds)].filter((id) => {
        const file = map.get(id);
        return file && !file.deletedAt;
      })
    );
    if (valid.size > 0) {
      this.refs.set(key, valid);
    } else {
      this.refs.delete(key);
    }
  }

  async removeSessionRefs(userId, sessionId) {
    this.refs.delete(`${userId}:${sessionId}`);
  }

  async clearRefs(userId) {
    const prefix = `${userId}:`;
    for (const key of [...this.refs.keys()]) {
      if (key.startsWith(prefix)) this.refs.delete(key);
    }
  }

  /** 测试辅助：读取某会话当前引用 */
  listRefs(userId, sessionId) {
    return [...(this.refs.get(`${userId}:${sessionId}`) ?? [])];
  }

  async close() {
    this.files.clear();
    this.refs.clear();
  }
}

module.exports = { MemoryFileRepo };
