'use strict';
/**
 * 生产备份：MySQL 逻辑备份 + 附件原件打包 + SHA256 + 保留期清理 + 可选异地副本。
 *
 * 用法：
 *   BACKUP_DIR=/var/backups/auth-demo node scripts/backup.js
 *
 * 依赖系统命令：mysqldump、tar、gzip（Linux 服务器默认具备）。
 * 需要 MYSQL_URL；FILES_MODE=local 时同时备份 FILES_DIR/blobs。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
require('../src/lib/load-env').loadEnv();
const { config } = require('../src/config');

const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/auth-demo';
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const OFFSITE_DIR = process.env.OFFSITE_DIR || '';
const MYSQLDUMP = process.env.MYSQLDUMP_BIN || 'mysqldump';

const timestamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
};

const human = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

function parseMysqlUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MYSQL_URL 不是合法 URL');
  }
  if (url.protocol !== 'mysql:') {
    throw new Error('MYSQL_URL 必须使用 mysql://');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error('MYSQL_URL 缺少数据库名');
  }
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function spawnWithError(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const reason = signal ? `signal ${signal}` : `exit ${code}`;
        reject(new Error(`${command} 失败（${reason}）${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
  return { child, done };
}

async function dumpDatabase(client, file) {
  const { child, done } = spawnWithError(
    MYSQLDUMP,
    [
      '--host', client.host,
      '--port', client.port,
      '--user', client.user,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--events',
      '--default-character-set=utf8mb4',
      '--databases', client.database,
    ],
    { env: { ...process.env, MYSQL_PWD: client.password } }
  );
  const gzip = zlib.createGzip({ level: 6 });
  const output = fs.createWriteStream(file, { mode: 0o600 });
  try {
    await Promise.all([pipeline(child.stdout, gzip, output), done]);
  } catch (error) {
    child.kill('SIGKILL');
    await fsp.rm(file, { force: true }).catch(() => {});
    throw error;
  }
}

async function tarFiles(filesDir, file) {
  const source = path.join(filesDir, 'blobs');
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return false;
  }
  await spawnWithError('tar', ['-czf', file, '-C', filesDir, 'blobs']).done;
  return true;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function writeChecksums(files, file) {
  const lines = [];
  for (const item of files) {
    lines.push(`${await sha256(item)}  ${path.basename(item)}`);
  }
  await fsp.writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
}

async function prune(dir, prefix, cutoff) {
  const entries = await fsp.readdir(dir).catch(() => []);
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const target = path.join(dir, name);
    const stat = await fsp.stat(target).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(target, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function copyOffsite(files) {
  if (!OFFSITE_DIR) return 0;
  if (path.resolve(OFFSITE_DIR) === path.resolve(BACKUP_DIR)) {
    throw new Error('OFFSITE_DIR 不能与 BACKUP_DIR 相同');
  }
  await fsp.mkdir(OFFSITE_DIR, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const file of files) {
    const target = path.join(OFFSITE_DIR, path.basename(file));
    await fsp.copyFile(file, target);
    const [sourceHash, targetHash] = await Promise.all([sha256(file), sha256(target)]);
    if (sourceHash !== targetHash) {
      throw new Error(`异地副本校验失败: ${target}`);
    }
    copied += 1;
  }
  return copied;
}

async function main() {
  if (!config.mysql.url) {
    throw new Error('MYSQL_URL 未设置，无法备份数据库');
  }
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) {
    throw new Error('BACKUP_RETENTION_DAYS 必须是正数');
  }
  const client = parseMysqlUrl(config.mysql.url);
  await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });

  const tag = timestamp();
  const dbFile = path.join(BACKUP_DIR, `auth-db-${tag}.sql.gz`);
  const filesArchive = path.join(BACKUP_DIR, `auth-files-${tag}.tar.gz`);
  const sumFile = path.join(BACKUP_DIR, `SHA256SUMS-${tag}`);
  const created = [];

  try {
    console.log(`[backup] 数据库 ${client.database} → ${dbFile}`);
    await dumpDatabase(client, dbFile);
    created.push(dbFile);

    let hasFiles = false;
    if (config.files.mode === 'local') {
      console.log(`[backup] 附件 ${config.files.dir}/blobs → ${filesArchive}`);
      hasFiles = await tarFiles(config.files.dir, filesArchive);
      if (hasFiles) created.push(filesArchive);
    }

    await writeChecksums(created, sumFile);
    created.push(sumFile);

    for (const file of created) {
      const stat = await fsp.stat(file);
      console.log(`[backup] ${path.basename(file)}  ${human(stat.size)}`);
    }

    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const removed = (
      await prune(BACKUP_DIR, 'auth-db-', cutoff) +
      await prune(BACKUP_DIR, 'auth-files-', cutoff) +
      await prune(BACKUP_DIR, 'SHA256SUMS-', cutoff)
    );
    if (removed > 0) {
      console.log(`[backup] 清理超过 ${RETENTION_DAYS} 天的备份 ${removed} 个`);
    }

    if (OFFSITE_DIR) {
      const copied = await copyOffsite(created);
      console.log(`[backup] 已复制 ${copied} 个文件到 ${OFFSITE_DIR}`);
    }
    console.log('[backup] 完成');
  } catch (error) {
    for (const file of created) {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
    await fsp.rm(sumFile, { force: true }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(`[backup] 失败: ${error.message}`);
  process.exit(1);
});
