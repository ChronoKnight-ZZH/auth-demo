'use strict';
/**
 * MySQL 8.4 UserRepo。全部 SQL 走 pool.execute 预处理，禁止字符串拼接。
 * 对应方案 §6.1.1。
 */
const mysql = require('mysql2/promise');
const { UserRepo } = require('./user-repo');
const { config } = require('../config');

class MysqlUserRepo extends UserRepo {
  constructor(url) {
    super();
    this.pool = mysql.createPool({
      uri: url || config.mysql.url,
      waitForConnections: true,
      connectionLimit: config.mysql.poolSize,
      timezone: 'Z',              // 全库 UTC
      dateStrings: false,
      namedPlaceholders: false,
    });
  }

  async ping() {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('SELECT 1');
      const [[row]] = await conn.query('SELECT VERSION() AS v');
      return row.v;
    } finally {
      conn.release();
    }
  }

  async findByUsername(username) {
    const [rows] = await this.pool.execute(
      `SELECT id, username, password_hash, credential_version, argon2_key_version, status
         FROM users WHERE username = ? LIMIT 1`,
      [username]
    );
    return rows[0] || null;
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      `SELECT id, username, password_hash, credential_version, argon2_key_version, status
         FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async updatePasswordHash(userId, phc, keyVersion) {
    const [r] = await this.pool.execute(
      `UPDATE users SET password_hash = ?, argon2_key_version = ? WHERE id = ?`,
      [phc, keyVersion, userId]
    );
    return r.affectedRows === 1;
  }

  /**
   * 改密：更新哈希 + 递增 credential_version，置于同一事务。
   * 返回新的 credential_version，供写穿 Redis credver 键。
   */
  async changePassword(userId, phc, keyVersion) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.execute(
        `UPDATE users
            SET password_hash = ?, argon2_key_version = ?,
                credential_version = credential_version + 1
          WHERE id = ?`,
        [phc, keyVersion, userId]
      );
      if (r.affectedRows !== 1) {
        await conn.rollback();
        throw new Error('user not found');
      }
      const [[row]] = await conn.execute(
        `SELECT credential_version FROM users WHERE id = ?`, [userId]
      );
      await conn.commit();
      return Number(row.credential_version);
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async createUser({ username, passwordHash }) {
    const [r] = await this.pool.execute(
      `INSERT INTO users (username, password_hash, credential_version, argon2_key_version, status)
       VALUES (?, ?, 1, 1, 'active')`,
      [username, passwordHash]
    );
    return this.findById(r.insertId);
  }

  async listUsers() {
    const [rows] = await this.pool.query(
      `SELECT id, username, status, credential_version, created_at
         FROM users
        ORDER BY id ASC`
    );
    return rows.map((row) => ({
      id: Number(row.id),
      username: row.username,
      status: row.status,
      credentialVersion: Number(row.credential_version),
      createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at),
    }));
  }

  async setStatus(userId, status) {
    if (status !== 'active' && status !== 'locked') {
      throw new Error('invalid user status');
    }
    const [r] = await this.pool.execute(
      'UPDATE users SET status = ? WHERE id = ?',
      [status, userId]
    );
    return r.affectedRows === 1;
  }

  /** 递增凭证版本；供锁定/管理员重置密码后撤销全部旧会话 */
  async revokeCredentials(userId) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.execute(
        'UPDATE users SET credential_version = credential_version + 1 WHERE id = ?',
        [userId]
      );
      if (r.affectedRows !== 1) {
        await conn.rollback();
        return null;
      }
      const [[row]] = await conn.execute(
        'SELECT credential_version FROM users WHERE id = ?', [userId]
      );
      await conn.commit();
      return Number(row.credential_version);
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async seed(users) {
    for (const u of users) {
      await this.pool.execute(
        `INSERT INTO users (username, password_hash, credential_version, argon2_key_version, status)
         VALUES (?, ?, 1, 1, 'active')
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
        [u.username, u.passwordHash]
      );
    }
  }

  async close() { await this.pool.end(); }
}

module.exports = { MysqlUserRepo };