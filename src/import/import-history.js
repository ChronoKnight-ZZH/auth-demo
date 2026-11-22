'use strict';
/**
 * 历史归档导入核心（不依赖命令行）。
 *
 * 调用方负责读取 ZIP 字节、解析账号与仓库；这里完成：
 * 校验归档 → 还原本地 Session → 归档图片到服务端 → 写库与引用 → 审计。
 */
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const fsPromises = require('node:fs/promises');
const { ZipArchive, ZipError } = require('./zip-reader');
const {
  ImportError,
  MAX_SESSION_BYTES,
  checkManifest,
  readSessionFile,
  readSessionIndex,
  toLocalSession,
} = require('./history');
const mimeSniff = require('../files/mime');
const blobStore = require('../files/blob-store');
const { config } = require('../config');

const MANIFEST_PATH = 'manifest.json';
const USER_PATH = 'user.json';
const INDEX_PATH = 'chat_session_index.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const SESSION_PATH_RE = /^chat_sessions\/([^/]+)\.json$/;
const IMAGE_DIR_RE = /^chat_sessions\/([^/]+)_files\//;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_IMPORT_BYTES = 512 * 1024 * 1024;

const json = (buffer, label) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ImportError(`${label} 不是合法 JSON`);
  }
};

/**
 * 校验归档并准备会话。
 * @returns {{ sessions: Array<{ file: object, local: object }>, index, skipped: Set<string> }}
 */
function prepare(archive, { mode, hasSession }) {
  if (archive.firstPath !== MANIFEST_PATH) {
    throw new ImportError('第一个条目必须是 manifest.json');
  }
  checkManifest(json(archive.read(MANIFEST_PATH, { maxBytes: MAX_MANIFEST_BYTES }), 'manifest.json'));

  const paths = archive.paths;
  const sessionPaths = [];
  const imageDirs = new Set();
  for (const path of paths) {
    if (
      path === MANIFEST_PATH ||
      path === INDEX_PATH ||
      path === USER_PATH ||
      path.endsWith('/')
    ) {
      continue;
    }
    const sessionMatch = SESSION_PATH_RE.exec(path);
    if (sessionMatch) {
      sessionPaths.push({ path, id: sessionMatch[1] });
      continue;
    }
    const imageMatch = IMAGE_DIR_RE.exec(path);
    if (imageMatch) {
      imageDirs.add(imageMatch[1]);
      continue;
    }
    throw new ImportError(`归档包含未知条目: ${path}`);
  }
  if (sessionPaths.length === 0) {
    throw new ImportError('归档中没有会话');
  }
  if (!paths.includes(INDEX_PATH)) {
    throw new ImportError('归档缺少 chat_session_index.json');
  }

  const index = readSessionIndex(
    json(archive.read(INDEX_PATH, { maxBytes: MAX_INDEX_BYTES }), 'chat_session_index.json')
  );
  const listed = new Set(index.map((entry) => entry.id));
  if (listed.size !== index.length) {
    throw new ImportError('索引中存在重复会话');
  }

  const byId = new Map();
  for (const { path, id } of sessionPaths) {
    if (byId.has(id)) {
      throw new ImportError(`重复的会话文件: ${path}`);
    }
    let file;
    try {
      file = readSessionFile(json(archive.read(path, { maxBytes: MAX_SESSION_BYTES }), path));
    } catch (error) {
      throw new ImportError(`${path}: ${error.message}`);
    }
    if (file.id !== id) {
      throw new ImportError(`会话 id 与文件名不一致: ${path}`);
    }
    byId.set(id, file);
  }
  if (byId.size !== listed.size) {
    throw new ImportError('索引与会话文件数量不一致');
  }
  for (const id of listed) {
    if (!byId.has(id)) {
      throw new ImportError(`索引中的会话缺少文件: ${id}`);
    }
  }
  for (const id of byId.keys()) {
    if (!listed.has(id)) {
      throw new ImportError(`会话文件未出现在索引中: ${id}`);
    }
  }

  const sessions = [];
  const skipped = new Set();
  for (const entry of index) {
    const file = byId.get(entry.id);
    const exists = hasSession(entry.id);
    if (exists && mode !== 'replace') {
      skipped.add(entry.id);
      continue;
    }
    try {
      sessions.push({ file, local: toLocalSession(file) });
    } catch (error) {
      throw new ImportError(`会话 ${entry.id}: ${error.message}`);
    }
  }

  // 图片目录只能属于归档里的会话；未引用图片允许存在，引用但缺失则只保留元数据
  for (const id of imageDirs) {
    if (!byId.has(id)) {
      throw new ImportError(`图片目录不属于任何会话: ${id}`);
    }
  }

  return { sessions, index, skipped, allSessions: byId };
}

/**
 * 把会话引用的图片存入内容寻址存储，返回 fileId → { storageId, mime, isImage }。
 */
async function storeImages({ archive, sessions, userId, fileRepo }) {
  const resolved = new Map();
  const seen = new Set();
  let filesImported = 0;
  let bytesImported = 0;

  for (const { local } of sessions) {
    for (const ref of local.images.values()) {
      if (seen.has(ref.fileId)) {
        continue;
      }
      seen.add(ref.fileId);
      if (!archive.has(ref.path)) {
        continue;
      }
      const data = archive.read(ref.path, { maxBytes: config.files.maxBytes });
      if (data.length === 0) {
        throw new ImportError(`图片为空: ${ref.path}`);
      }
      if (data.length > config.files.maxBytes) {
        throw new ImportError(`图片超过 ${config.files.maxBytes} 字节上限: ${ref.path}`);
      }

      let uploaded;
      try {
        uploaded = await blobStore.putStream(Readable.from([data]), {
          limit: config.files.maxBytes,
        });
        const detected = await mimeSniff.detect(uploaded.tmp, { name: ref.name });
        const committed = await blobStore.commit(
          uploaded.tmp,
          uploaded.sha256,
          uploaded.size,
          userId
        );
        const file = await fileRepo.create(userId, {
          id: crypto.randomUUID(),
          sha256: committed.sha256,
          storageKey: committed.storageKey,
          size: uploaded.size,
          mime: detected.mime,
          name: [...ref.name].slice(0, 255).join(''),
          isImage: detected.isImage,
          createdAt: Number.isFinite(ref.insertedAt) && ref.insertedAt > 0
            ? ref.insertedAt
            : Date.now(),
        });
        resolved.set(ref.fileId, {
          storageId: file.id,
          mime: file.mime,
          isImage: file.isImage,
        });
        filesImported += 1;
        bytesImported += uploaded.size;
      } finally {
        if (uploaded) {
          await fsPromises.rm(uploaded.tmp, { force: true }).catch(() => {});
        }
      }
    }
  }

  return { resolved, filesImported, bytesImported };
}

/**
 * 导入归档字节。
 *
 * @param {object} options
 * @param {{ id: number, username: string }} options.user
 * @param {string} options.actor 执行者（OS 账号或显式传入）
 * @param {string} options.source 来源文件名
 * @param {Buffer} options.archiveBuffer ZIP 字节
 * @param {boolean} [options.dryRun]
 * @param {'skip'|'replace'} [options.mode]
 * @param {object} options.chatRepo
 * @param {object} options.fileRepo
 * @param {object} [options.auditRepo]
 * @param {number} [options.maxTotalBytes]
 */
async function importArchive({
  user,
  actor,
  source,
  archiveBuffer,
  dryRun = false,
  mode = 'skip',
  chatRepo,
  fileRepo,
  auditRepo,
  maxTotalBytes = DEFAULT_MAX_IMPORT_BYTES,
}) {
  if (!Buffer.isBuffer(archiveBuffer)) {
    throw new ImportError('归档内容为空');
  }
  if (mode !== 'skip' && mode !== 'replace') {
    throw new ImportError(`未知导入模式: ${mode}`);
  }
  if (archiveBuffer.length > MAX_ARCHIVE_BYTES) {
    throw new ImportError(`ZIP 文件超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
  }
  const sourceSha256 = crypto.createHash('sha256').update(archiveBuffer).digest('hex');

  let jobId = null;
  if (auditRepo && !dryRun) {
    jobId = await auditRepo
      .start({ userId: user.id, actor, source, sourceSha256, mode })
      .catch((error) => {
        console.error('[import] 审计写入失败:', error.message);
        return null;
      });
  }

  const summary = {
    jobId,
    dryRun,
    sessionsTotal: 0,
    sessionsImported: 0,
    sessionsSkipped: 0,
    filesImported: 0,
    bytesImported: 0,
  };

  try {
    const archive = new ZipArchive(archiveBuffer, {
      maxEntryBytes: Math.max(config.files.maxBytes, MAX_SESSION_BYTES),
      maxTotalBytes,
    });

    // hasSession 是同步接口；先取现有会话集合，避免 prepare 变成异步
    const existing = new Set();
    // 这里按需查询：会话数量通常很小，逐个 await 即可
    const sessionsToCheck = [...new Set(
      archive.paths
        .map((path) => SESSION_PATH_RE.exec(path)?.[1])
        .filter(Boolean)
    )];
    for (const id of sessionsToCheck) {
      if (await chatRepo.hasSession(user.id, id)) {
        existing.add(id);
      }
    }

    const prepared = prepare(archive, {
      mode,
      hasSession: (id) => existing.has(id),
    });
    summary.sessionsTotal = prepared.index.length;
    summary.sessionsSkipped = prepared.skipped.size;

    if (dryRun) {
      summary.sessionsImported = prepared.sessions.length;
      return summary;
    }

    const { resolved, filesImported, bytesImported } = await storeImages({
      archive,
      sessions: prepared.sessions,
      userId: user.id,
      fileRepo,
    });
    summary.filesImported = filesImported;
    summary.bytesImported = bytesImported;

    const created = [];
    try {
      for (const { file, local } of prepared.sessions) {
        const converted = toLocalSession(file, resolved);
        if (mode === 'replace') {
          await fileRepo.removeSessionRefs(user.id, file.id);
          await chatRepo.purgeSession(user.id, file.id);
        }
        await chatRepo.saveSession(user.id, converted.session);
        const storageIds = converted.session.messages
          .flatMap((message) => (message.role === 'user' ? message.files : []))
          .map((item) => item.storageId)
          .filter(Boolean);
        await fileRepo.syncRefs(user.id, file.id, storageIds);
        created.push(file.id);
        summary.sessionsImported += 1;
      }
    } catch (error) {
      // 补偿回滚：删除本次新增/替换的会话；已替换的旧内容无法恢复
      for (const id of created) {
        await fileRepo.removeSessionRefs(user.id, id).catch(() => {});
        await chatRepo.purgeSession(user.id, id).catch(() => {});
      }
      summary.sessionsImported = 0;
      throw error;
    }

    if (auditRepo && jobId) {
      await auditRepo
        .finish(jobId, { status: 'success', ...summary })
        .catch((error) => console.error('[import] 审计写入失败:', error.message));
    }
    return summary;
  } catch (error) {
    if (auditRepo && jobId) {
      await auditRepo
        .finish(jobId, {
          status: 'failed',
          ...summary,
          error: String(error.message || error).slice(0, 1000),
        })
        .catch((auditError) => console.error('[import] 审计写入失败:', auditError.message));
    }
    if (error instanceof ZipError) {
      throw new ImportError(error.reason || error.message);
    }
    throw error;
  }
}

module.exports = {
  importArchive,
  MANIFEST_PATH,
  INDEX_PATH,
  MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_IMPORT_BYTES,
};
