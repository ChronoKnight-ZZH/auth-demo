'use strict';
/**
 * 管理员账号 CLI（里程碑 4）。
 *
 * 用法：
 *   node scripts/admin.js list
 *   node scripts/admin.js create --username alice [--password ...]
 *   node scripts/admin.js lock --username alice
 *   node scripts/admin.js unlock --username alice
 *   node scripts/admin.js reset-password --username alice [--password ...]
 *
 * 未提供 --password 时：终端内隐藏输入；非终端从 stdin 读取一行。
 * 需要 MYSQL_URL；锁定/重置密码会同时撤销该用户全部旧会话。
 */
const { parseArgs } = require('node:util');
require('../src/lib/load-env').loadEnv();
const { config } = require('../src/config');
const { MysqlUserRepo } = require('../src/db/mysql-user-repo');
const { RedisSessionStore } = require('../src/session/redis-store');
const { MemorySessionStore } = require('../src/session/memory-store');
const { createAdminService } = require('../src/account/admin-service');

const USAGE = `用法：
  node scripts/admin.js <命令> [选项]

命令：
  list                         列出账号
  create --username <u>        创建账号（--password 可选）
  lock --username <u>          锁定账号并撤销全部会话
  unlock --username <u>        解锁账号
  reset-password --username <u> 重置密码并撤销全部会话

选项：
  --username <u>               用户名
  --password <p>               密码；不传则交互输入（推荐）
  -h, --help                   显示帮助`;

function parse() {
  try {
    const { values, positionals } = parseArgs({
      options: {
        username: { type: 'string' },
        password: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
    return { values, positionals };
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
};

function promptHidden(label) {
  if (!process.stdin.isTTY) {
    return readStdin();
  }
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

async function passwordFor(argv) {
  if (argv.password !== undefined) {
    return argv.password;
  }
  return promptHidden('密码: ');
}

const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 19) : '-';
};

async function main() {
  const { values, positionals } = parse();
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }
  const command = positionals[0];
  if (!['list', 'create', 'lock', 'unlock', 'reset-password'].includes(command)) {
    console.error(`未知命令: ${command}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!config.mysql.url) {
    console.error('账号管理需要 MYSQL_URL（内存模式只在单个进程内有效）');
    process.exitCode = 1;
    return;
  }
  if (command !== 'list' && !values.username) {
    console.error('缺少 --username');
    process.exitCode = 2;
    return;
  }

  const userRepo = new MysqlUserRepo();
  const needsSessionStore = command === 'lock' || command === 'reset-password';
  if (needsSessionStore && !config.redis.url) {
    console.warn('提示：未配置 REDIS_URL，版本键只写入当前 CLI 进程，无法撤销正在运行的服务端会话');
  }
  const sessionStore = needsSessionStore
    ? (config.redis.url ? new RedisSessionStore() : new MemorySessionStore())
    : null;
  const service = createAdminService({ userRepo, sessionStore });
  try {
    if (command === 'list') {
      const users = await service.listUsers();
      console.log('id\tusername\tstatus\tcredver\tcreated_at');
      for (const user of users) {
        console.log(
          `${user.id}\t${user.username}\t${user.status}\t${user.credentialVersion}\t${formatDate(user.createdAt)}`
        );
      }
      return;
    }
    if (command === 'create') {
      const password = await passwordFor(values);
      const user = await service.createUser({ username: values.username, password });
      console.log(`已创建账号 #${user.id} ${user.username}（${user.status}）`);
      return;
    }
    if (command === 'lock') {
      const result = await service.lockUser(values.username);
      console.log(result.changed ? `已锁定 ${result.username}，旧会话已撤销` : `${result.username} 已经是锁定状态`);
      return;
    }
    if (command === 'unlock') {
      const result = await service.unlockUser(values.username);
      console.log(result.changed ? `已解锁 ${result.username}` : `${result.username} 已经是正常状态`);
      return;
    }
    if (command === 'reset-password') {
      const password = await passwordFor(values);
      const result = await service.resetPassword(values.username, password);
      console.log(
        `已重置 ${result.username} 的密码；凭证版本 ${result.credentialVersion}，` +
          `旧会话已撤销（版本键 TTL ${result.ttlDays} 天）`
      );
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      console.error(`用户名已存在: ${values.username}`);
    } else {
      console.error(`操作失败：${error.message}`);
    }
    process.exitCode = 1;
  } finally {
    await Promise.all([
      userRepo.close().catch(() => {}),
      sessionStore ? sessionStore.close().catch(() => {}) : Promise.resolve(),
    ]);
  }
}

main();
