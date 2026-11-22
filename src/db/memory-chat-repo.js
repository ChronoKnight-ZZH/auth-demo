'use strict';
/**
 * 内存 ChatRepo：零依赖模式与测试用，语义与 MysqlChatRepo 一致。
 */
const { ChatRepo } = require('./chat-repo');

const clone = (value) => JSON.parse(JSON.stringify(value));

class MemoryChatRepo extends ChatRepo {
  constructor() {
    super();
    /** userId -> Map<id, session> */
    this.users = new Map();
  }

  async ping() { return true; }

  _map(userId) {
    let map = this.users.get(String(userId));
    if (!map) {
      map = new Map();
      this.users.set(String(userId), map);
    }
    return map;
  }

  async listSessions(userId) {
    return [...this._map(userId).values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }));
  }

  async listAllSessions(userId) {
    return [...this._map(userId).values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(clone);
  }

  async getSession(userId, id) {
    const session = this._map(userId).get(id);
    return session ? clone(session) : null;
  }

  async hasSession(userId, id) {
    return this._map(userId).has(id);
  }

  async saveSession(userId, session) {
    this._map(userId).set(session.id, clone(session));
    return clone(session);
  }

  async purgeSession(userId, id) {
    return this._map(userId).delete(id);
  }

  async renameSession(userId, id, title) {
    const session = this._map(userId).get(id);
    if (!session) return false;
    session.title = title;
    session.updatedAt = Date.now();
    return true;
  }

  async deleteSession(userId, id) {
    return this._map(userId).delete(id);
  }

  async clearSessions(userId) {
    const map = this._map(userId);
    const count = map.size;
    map.clear();
    return count;
  }

  async close() {
    this.users.clear();
  }
}

module.exports = { MemoryChatRepo };
