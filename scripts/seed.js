'use strict';
/**
 * 创建种子用户（方案 A-B-04）。
 * 用法：node scripts/seed.js [--mysql]
 *   默认写入内存库仅作校验；带 --mysql 时写 MySQL。
 */
const path = require('node:path');
require('../src/lib/load-env').loadEnv();
const { config } = require('../src/config');
const { hashPassword } = require('../src/crypto/password');

const SEED_USERS = [
  { username: 'alice', password: 'Alice@Passw0rd' },
  { username: 'bob', password: 'Bob@Passw0rd' },
];

async function main() {
  const users = [];
  for (const u of SEED_USERS) {
    const phc = await hashPassword(u.password);
    users.push({ username: u.username, passwordHash: phc });
    console.log(`已生成 ${u.username} 的 PHC：${phc.slice(0, 46)}...`);
  }

  if (process.argv.includes('--mysql')) {
    if (!config.mysql.url) {
      console.error('MYSQL_URL 未设置');
      process.exit(1);
    }
    const { MysqlUserRepo } = require('../src/db/mysql-user-repo');
    const repo = new MysqlUserRepo();
    await repo.seed(users);
    await repo.close();
    console.log(`\n已写入 MySQL，共 ${users.length} 个用户。`);
  } else {
    console.log('\n未指定 --mysql，仅生成哈希（供检查）。');
  }

  console.log('\n种子账号：');
  for (const u of SEED_USERS) console.log(`  ${u.username} / ${u.password}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });