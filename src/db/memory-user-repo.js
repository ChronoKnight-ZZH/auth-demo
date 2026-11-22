'use strict';
/**
 * 内存 UserRepo —— 零依赖演示实现，语义与 MysqlUserRepo 对齐。
 */
const { UserRepo } = require('./user-repo');

class MemoryUserRepo extends UserRepo {
  constructor() {
    super();
    this.users = new Map(); // username -> record
    this.nextId = 1;
  }

  async ping() { return 'memory'; }

  async findByUsername(username) {
    const u = this.users.get(username);
    return u ? { ...u } : null;
  }

  async findById(id) {
    for (const u of this.users.values()) if (u.id === Number(id)) return { ...u };
    return null;
  }

  async updatePasswordHash(userId, phc, keyVersion) {
    for (const u of this.users.values()) {
      if (u.id === Number(userId)) {
        u.password_hash = phc;
        u.argon2_key_version = keyVersion;
        return true;
      }
    }
    return false;
  }

  async changePassword(userId, phc, keyVersion) {
    for (const u of this.users.values()) {
      if (u.id === Number(userId)) {
        u.password_hash = phc;
        u.argon2_key_version = keyVersion;
        u.credential_version += 1;
        return u.credential_version;
      }
    }
    throw new Error('user not found');
  }

  async seed(users) {
    for (const u of users) {
      const existing = this.users.get(u.username);
      if (existing) {
        existing.password_hash = u.passwordHash;
      } else {
        this.users.set(u.username, {
          id: this.nextId++,
          username: u.username,
          password_hash: u.passwordHash,
          credential_version: 1,
          argon2_key_version: 1,
          status: 'active',
          created_at: Date.now(),
        });
      }
    }
  }

  async createUser({ username, passwordHash }) {
    if (this.users.has(username)) {
      const error = new Error('duplicate username');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const user = {
      id: this.nextId++,
      username,
      password_hash: passwordHash,
      credential_version: 1,
      argon2_key_version: 1,
      status: 'active',
      created_at: Date.now(),
    };
    this.users.set(username, user);
    return { ...user };
  }

  async listUsers() {
    return [...this.users.values()]
      .sort((a, b) => a.id - b.id)
      .map((user) => ({
        id: user.id,
        username: user.username,
        status: user.status,
        credentialVersion: user.credential_version,
        createdAt: user.created_at,
      }));
  }

  /** 演示用：直接改状态，供 A-E-08 验收 */
  async setStatus(userId, status) {
    for (const u of this.users.values()) {
      if (u.id === Number(userId)) { u.status = status; return true; }
    }
    return false;
  }

  async revokeCredentials(userId) {
    for (const u of this.users.values()) {
      if (u.id === Number(userId)) {
        u.credential_version += 1;
        return u.credential_version;
      }
    }
    return null;
  }

  async close() {}
}

module.exports = { MemoryUserRepo };