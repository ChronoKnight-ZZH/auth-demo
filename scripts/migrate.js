'use strict';
/**
 * 执行迁移（方案 A-B-04）。需 MYSQL_URL。
 * 用法：node scripts/migrate.js [--database]
 *   --database 会先 CREATE DATABASE IF NOT EXISTS
 */
const fs = require('node:fs');
const path = require('node:path');
require('../src/lib/load-env').loadEnv();
const mysql = require('mysql2/promise');
const { config } = require('../src/config');

async function main() {
  if (!config.mysql.url) {
    console.error('MYSQL_URL 未设置，无法执行迁移。');
    process.exit(1);
  }

  const url = new URL(config.mysql.url);
  const dbName = url.pathname.replace(/^\//, '');
  url.pathname = '/';

  if (process.argv.includes('--database')) {
    const root = await mysql.createConnection({ uri: url.toString() });
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\`
       DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
    await root.end();
    console.log(`数据库 ${dbName} 已就绪`);
  }

  const conn = await mysql.createConnection({ uri: config.mysql.url, multipleStatements: true });
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await conn.query(sql);
    console.log(`已执行 ${f}`);
  }

  const [[v]] = await conn.query('SELECT VERSION() AS v');
  console.log(`MySQL 版本：${v.v}`);
  await conn.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });