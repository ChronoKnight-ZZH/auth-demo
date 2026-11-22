'use strict';
/**
 * MySQL FileRepo。全部 SQL 走 pool.execute 预处理；fileIds 列表只用于生成
 * 固定数量的 `?` 占位符，值本身仍作为参数绑定。
 */
const mysql = require('mysql2/promise');
const { FileRepo } = require('./file-repo');
const { config } = require('../config');

const COLUMNS = 'id, sha256, storage_key, size, mime, name, is_image, created_at, deleted_at';

function toFile(row) {
  return {
    id: row.id,
    sha256: row.sha256,
    storageKey: row.storage_key,
    size: Number(row.size),
    mime: row.mime,
    name: row.name,
    isImage: Number(row.is_image) === 1,
    createdAt: Number(row.created_at),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  };
}

class MysqlFileRepo extends FileRepo {
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

  async create(userId, file) {
    const [rows] = await this.pool.execute(
      `SELECT ${COLUMNS} FROM app_files
        WHERE owner_id = ? AND sha256 = ? AND deleted_at IS NULL
        LIMIT 1`,
      [userId, file.sha256]
    );
    if (rows[0]) return toFile(rows[0]);

    await this.pool.execute(
      `INSERT INTO app_files
         (id, owner_id, sha256, storage_key, size, mime, name, is_image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.id,
        userId,
        file.sha256,
        file.storageKey,
        file.size,
        file.mime,
        file.name,
        file.isImage ? 1 : 0,
        file.createdAt,
      ]
    );
    return { ...file, deletedAt: null };
  }

  async get(userId, id) {
    const [rows] = await this.pool.execute(
      `SELECT ${COLUMNS} FROM app_files
        WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [id, userId]
    );
    return rows[0] ? toFile(rows[0]) : null;
  }

  async softDelete(userId, id) {
    const [result] = await this.pool.execute(
      'UPDATE app_files SET deleted_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
      [Date.now(), id, userId]
    );
    return result.affectedRows === 1;
  }

  async syncRefs(userId, sessionId, fileIds) {
    const ids = [...new Set(fileIds)].filter((id) => typeof id === 'string');
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (ids.length === 0) {
        await conn.execute('DELETE FROM app_file_refs WHERE session_id = ? AND user_id = ?', [
          sessionId,
          userId,
        ]);
      } else {
        const placeholders = ids.map(() => '?').join(',');
        await conn.execute(
          `DELETE FROM app_file_refs
            WHERE session_id = ? AND user_id = ? AND file_id NOT IN (${placeholders})`,
          [sessionId, userId, ...ids]
        );
        await conn.execute(
          `INSERT IGNORE INTO app_file_refs (file_id, session_id, user_id, created_at)
           SELECT id, ?, ?, ? FROM app_files
            WHERE owner_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
          [sessionId, userId, Date.now(), userId, ...ids]
        );
      }
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw error;
    } finally {
      conn.release();
    }
  }

  async removeSessionRefs(userId, sessionId) {
    await this.pool.execute('DELETE FROM app_file_refs WHERE session_id = ? AND user_id = ?', [
      sessionId,
      userId,
    ]);
  }

  async clearRefs(userId) {
    await this.pool.execute('DELETE FROM app_file_refs WHERE user_id = ?', [userId]);
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { MysqlFileRepo };
