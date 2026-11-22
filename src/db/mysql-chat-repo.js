'use strict';
/**
 * MySQL ChatRepo。
 * 会话归属校验与写入放在同一事务；messages 为 JSON，按原样保存前端结构。
 */
const mysql = require('mysql2/promise');
const { ChatRepo } = require('./chat-repo');
const { config } = require('../config');
const { AppError } = require('../lib/errors');

const SUMMARY_COLUMNS = 'id, title, created_at, updated_at';
const FULL_COLUMNS = 'id, title, root_message_id, messages, created_at, updated_at';

function parseMessages(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

function toSummary(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSession(row) {
  return {
    ...toSummary(row),
    rootMessageId: row.root_message_id == null ? null : row.root_message_id,
    messages: parseMessages(row.messages),
  };
}

class MysqlChatRepo extends ChatRepo {
  constructor(url) {
    super();
    this.pool = mysql.createPool({
      uri: url || config.mysql.url,
      waitForConnections: true,
      connectionLimit: config.mysql.poolSize,
      timezone: 'Z',
      dateStrings: false,
      namedPlaceholders: false,
    });
  }

  async ping() {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('SELECT 1');
      return true;
    } finally {
      conn.release();
    }
  }

  async listSessions(userId) {
    const [rows] = await this.pool.execute(
      `SELECT ${SUMMARY_COLUMNS}
         FROM chat_sessions
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1000`,
      [userId]
    );
    return rows.map(toSummary);
  }

  async listAllSessions(userId) {
    const [rows] = await this.pool.execute(
      `SELECT ${FULL_COLUMNS}
         FROM chat_sessions
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1000`,
      [userId]
    );
    return rows.map(toSession);
  }

  async getSession(userId, id) {
    const [rows] = await this.pool.execute(
      `SELECT ${FULL_COLUMNS}
         FROM chat_sessions
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [id, userId]
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async saveSession(userId, session) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT user_id, deleted_at FROM chat_sessions WHERE id = ? FOR UPDATE',
        [session.id]
      );
      if (rows.length > 0) {
        if (Number(rows[0].user_id) !== Number(userId) || rows[0].deleted_at !== null) {
          throw new AppError('NOT_FOUND');
        }
        await conn.execute(
          `UPDATE chat_sessions
              SET title = ?, root_message_id = ?, messages = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`,
          [
            session.title,
            session.rootMessageId,
            JSON.stringify(session.messages),
            session.updatedAt,
            session.id,
            userId,
          ]
        );
      } else {
        await conn.execute(
          `INSERT INTO chat_sessions
             (id, user_id, title, root_message_id, messages, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            session.id,
            userId,
            session.title,
            session.rootMessageId,
            JSON.stringify(session.messages),
            session.createdAt,
            session.updatedAt,
          ]
        );
      }
      await conn.commit();
      return session;
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async renameSession(userId, id, title) {
    const [r] = await this.pool.execute(
      `UPDATE chat_sessions
          SET title = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [title, Date.now(), id, userId]
    );
    return r.affectedRows === 1;
  }

  async deleteSession(userId, id) {
    const [r] = await this.pool.execute(
      `UPDATE chat_sessions
          SET deleted_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [Date.now(), id, userId]
    );
    return r.affectedRows === 1;
  }

  async clearSessions(userId) {
    const [r] = await this.pool.execute(
      'DELETE FROM chat_sessions WHERE user_id = ?',
      [userId]
    );
    return r.affectedRows;
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { MysqlChatRepo };
