'use strict';
/**
 * 历史归档导入 CLI（里程碑 4）。
 *
 * 用法：
 *   node scripts/import-history.js --user alice --file deepseek_data-2026-11-22.zip
 *   node scripts/import-history.js --user alice --file backup.zip --dry-run
 *   node scripts/import-history.js --user alice --file backup.zip --replace
 *
 * 需要 MYSQL_URL；文件原件写入 FILES_DIR。重复导入同一 ZIP 默认跳过已存在会话。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('node:util');
require('../src/lib/load-env').loadEnv();
const { config } = require('../src/config');
const { MysqlUserRepo } = require('../src/db/mysql-user-repo');
const { MysqlChatRepo } = require('../src/db/mysql-chat-repo');
const { MysqlFileRepo } = require('../src/db/mysql-file-repo');
const { AuditRepo } = require('../src/db/audit-repo');
const blobStore = require('../src/files/blob-store');
const {
  importArchive,
  MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_IMPORT_BYTES,
} = require('../src/import/import-history');

const USAGE = `用法：
  node scripts/import-history.js --user <用户名> --file <zip> [选项]

选项：
  --dry-run          只校验并统计，不写数据库/磁盘
  --replace          覆盖已存在的同 id 会话（默认跳过）
  --actor <name>     审计中的执行者，默认当前系统账号
  --max-mb <n>       解压总量上限（MiB），默认 ${DEFAULT_MAX_IMPORT_BYTES / 1024 / 1024}
  -h, --help         显示帮助`;

function parse() {
  try {
    const { values } = parseArgs({
      options: {
        user: { type: 'string' },
        file: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        actor: { type: 'string' },
        'max-mb': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    return values;
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
}

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

async function main() {
  const argv = parse();
  if (argv.help) {
    console.log(USAGE);
    return;
  }
  if (!argv.user) {
    console.error('缺少 --user');
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!argv.file) {
    console.error('缺少 --file');
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!config.mysql.url) {
    console.error('历史导入需要 MYSQL_URL（内存模式无法持久化）');
    process.exitCode = 1;
    return;
  }

  const maxMb = argv['max-mb'] ? Number(argv['max-mb']) : null;
  if (maxMb !== null && (!Number.isFinite(maxMb) || maxMb <= 0)) {
    console.error('--max-mb 必须是正数');
    process.exitCode = 2;
    return;
  }

  const userRepo = new MysqlUserRepo();
  const chatRepo = new MysqlChatRepo();
  const fileRepo = new MysqlFileRepo();
  const auditRepo = new AuditRepo();
  let fileBuffer;
  try {
    const user = await userRepo.findByUsername(argv.user);
    if (!user) {
      throw new Error(`用户不存在: ${argv.user}`);
    }

    const stat = await fs.stat(argv.file);
    if (!stat.isFile()) {
      throw new Error(`不是文件: ${argv.file}`);
    }
    if (stat.size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `ZIP 文件 ${formatBytes(stat.size)} 超过上限 ${formatBytes(MAX_ARCHIVE_BYTES)}`
      );
    }
    fileBuffer = await fs.readFile(argv.file);

    await blobStore.init();
    const actor = argv.actor || (() => {
      try {
        return os.userInfo().username;
      } catch {
        return 'unknown';
      }
    })();

    const mode = argv.replace ? 'replace' : 'skip';
    console.log(`开始导入：用户=${user.username} 文件=${path.basename(argv.file)} 模式=${mode}`);
    const summary = await importArchive({
      user,
      actor,
      source: path.basename(argv.file),
      archiveBuffer: fileBuffer,
      dryRun: argv['dry-run'],
      mode,
      chatRepo,
      fileRepo,
      auditRepo,
      maxTotalBytes: maxMb ? Math.floor(maxMb * 1024 * 1024) : DEFAULT_MAX_IMPORT_BYTES,
    });

    const prefix = summary.dryRun ? '校验通过（dry-run，未写入）' : '导入完成';
    console.log(
      `${prefix}：会话共 ${summary.sessionsTotal}，` +
        `导入 ${summary.sessionsImported}，跳过 ${summary.sessionsSkipped}；` +
        `图片 ${summary.filesImported}（${formatBytes(summary.bytesImported)}）`
    );
    if (summary.jobId) {
      console.log(`审计记录：import_jobs #${summary.jobId}`);
    }
  } catch (error) {
    console.error(`导入失败：${error.message}`);
    if (!error.code) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  } finally {
    await Promise.all([
      chatRepo.close().catch(() => {}),
      fileRepo.close().catch(() => {}),
      userRepo.close().catch(() => {}),
      auditRepo.close().catch(() => {}),
    ]);
  }
}

main();
