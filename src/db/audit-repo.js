'use strict';
/**
 * 导入审计。写入失败不应影响导入本身：调用方统一 catch 并告警。
 */
const mysql = require('mysql2/promise');
const { config } = require('../config');

class AuditRepo {
  constructor(url) {
    this.url = url || config.mysql.url;
    this.pool = this.url
      ? mysql.createPool({
          uri: this.url,
          waitForConnections: true,
          connectionLimit: 2,
          timezone: 'Z',
        })
      : null;
  }

  async start({ userId, actor, source, sourceSha256, mode }) {
    if (!this.pool) return null;
    const [result] = await this.pool.execute(
      `INSERT INTO import_jobs
         (user_id, actor, source, source_sha256, mode, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      [
        userId,
        String(actor || 'unknown').slice(0, 128),
        String(source || '').slice(0, 512),
        sourceSha256 || null,
        mode || 'skip',
        Date.now(),
      ]
    );
    return Number(result.insertId);
  }

  async finish(id, patch) {
    if (!this.pool || !id) return;
    const status = patch.status || 'failed';
    await this.pool.execute(
      `UPDATE import_jobs
          SET status = ?, sessions_total = ?, sessions_imported = ?,
              sessions_skipped = ?, files_imported = ?, bytes_imported = ?,
              error = ?, finished_at = ?
        WHERE id = ?`,
      [
        status,
        Number(patch.sessionsTotal || 0),
        Number(patch.sessionsImported || 0),
        Number(patch.sessionsSkipped || 0),
        Number(patch.filesImported || 0),
        Number(patch.bytesImported || 0),
        patch.error ? String(patch.error).slice(0, 1000) : null,
        Date.now(),
        id,
      ]
    );
  }

  async close() {
    await this.pool?.end();
  }
}

module.exports = { AuditRepo };
