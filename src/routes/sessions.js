'use strict';
/**
 * 会话持久化路由（里程碑 2）。
 *
 * 会话以整条 JSON 保存，前端切分支、切版本、续写都能原样往返。
 * 所有路由先鉴权，再按用户隔离；跨用户访问统一返回 404。
 */
const express = require('express');
const { AppError, sendError } = require('../lib/errors');

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STORAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGES = 5000;
const MAX_MESSAGES_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_CHARS = 255;
const MAX_FILES_PER_MESSAGE = 200;
/** 与 syncRefs 的占位符数量挂钩：去重后最多同步这么多引用 */
const MAX_FILE_REFS = 4000;

/** 收集消息里引用的原件 id；无效值直接忽略，避免脏数据进引用表 */
function collectStorageIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.files)) continue;
    for (const file of message.files) {
      const id = file && file.storageId;
      if (typeof id === 'string' && STORAGE_ID_RE.test(id)) {
        ids.add(id);
        if (ids.size >= MAX_FILE_REFS) return [...ids];
      }
    }
  }
  return [...ids];
}

/** 附件引用同步失败不阻塞会话保存：文件是附属资源，可后续补写 */
async function syncSessionRefs(fileRepo, userId, sessionId, messages) {
  if (!fileRepo) return;
  try {
    await fileRepo.syncRefs(userId, sessionId, collectStorageIds(messages));
  } catch (error) {
    console.error('[sessions] sync file refs failed:', error.message);
  }
}

function invalid(why) {
  // 仅用于本地排查：对外仍是统一的 INVALID_INPUT
  console.error('[sessions] invalid input:', why);
  const error = new AppError('INVALID_INPUT');
  error.why = why;
  return error;
}

function parseSession(body, forcedId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body');
  }
  const id = forcedId || body.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid('id');
  if (typeof body.title !== 'string') {
    throw invalid('title');
  }
  const title = [...body.title].slice(0, MAX_TITLE_CHARS).join('');
  if (!Array.isArray(body.messages) || body.messages.length > MAX_MESSAGES) {
    throw invalid('messages-array');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw invalid('message-object');
    }
    if (typeof message.id !== 'string' || !MESSAGE_ID_RE.test(message.id)) throw invalid('message-id');
    if (message.role !== 'user' && message.role !== 'assistant') throw invalid('message-role');
    if (message.files !== undefined) {
      if (!Array.isArray(message.files) || message.files.length > MAX_FILES_PER_MESSAGE) {
        throw invalid('message-files');
      }
      for (const file of message.files) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) throw invalid('file-object');
        if (
          file.storageId !== undefined &&
          file.storageId !== null &&
          (typeof file.storageId !== 'string' || !STORAGE_ID_RE.test(file.storageId))
        ) {
          throw invalid('file-storage-id');
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(body.messages), 'utf8') > MAX_MESSAGES_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE');
  }
  const createdAt = Number(body.createdAt);
  const updatedAt = Number(body.updatedAt);
  if (!Number.isFinite(createdAt) || createdAt < 0) throw invalid('createdAt');
  if (!Number.isFinite(updatedAt) || updatedAt < 0) throw invalid('updatedAt');
  const rootMessageId = body.rootMessageId;
  if (
    rootMessageId !== undefined &&
    rootMessageId !== null &&
    (typeof rootMessageId !== 'string' || !MESSAGE_ID_RE.test(rootMessageId))
  ) {
    throw invalid('rootMessageId');
  }
  return {
    id,
    title,
    createdAt,
    updatedAt,
    rootMessageId: rootMessageId ?? null,
    messages: body.messages,
  };
}

function createSessionRoutes({ chatRepo, authenticate, fileRepo }) {
  const router = express.Router();
  router.use(authenticate);

  router.get('/sessions', async (req, res) => {
    if (req.query.full === '1') {
      return res.json({ sessions: await chatRepo.listAllSessions(req.userId) });
    }
    return res.json({ sessions: await chatRepo.listSessions(req.userId) });
  });

  router.get('/sessions/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return sendError(res, 'INVALID_INPUT');
    const session = await chatRepo.getSession(req.userId, req.params.id);
    if (!session) return sendError(res, 'NOT_FOUND');
    return res.json(session);
  });

  router.post(
    '/sessions',
    express.json({ limit: '8mb' }),
    async (req, res) => {
      const session = parseSession(req.body);
      await chatRepo.saveSession(req.userId, session);
      await syncSessionRefs(fileRepo, req.userId, session.id, session.messages);
      return res.status(201).json({ ok: true, session });
    }
  );

  router.put(
    '/sessions/:id',
    express.json({ limit: '8mb' }),
    async (req, res) => {
      if (!ID_RE.test(req.params.id)) return sendError(res, 'INVALID_INPUT');
      const session = parseSession(req.body, req.params.id);
      await chatRepo.saveSession(req.userId, session);
      await syncSessionRefs(fileRepo, req.userId, session.id, session.messages);
      return res.json({ ok: true, session });
    }
  );

  router.patch(
    '/sessions/:id',
    express.json({ limit: '16kb' }),
    async (req, res) => {
      if (!ID_RE.test(req.params.id)) return sendError(res, 'INVALID_INPUT');
      const rawTitle = req.body?.title;
      if (typeof rawTitle !== 'string') {
        return sendError(res, 'INVALID_INPUT');
      }
      const title = [...rawTitle].slice(0, MAX_TITLE_CHARS).join('');
      const updated = await chatRepo.renameSession(req.userId, req.params.id, title);
      if (!updated) return sendError(res, 'NOT_FOUND');
      return res.json({ ok: true });
    }
  );

  router.delete('/sessions/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return sendError(res, 'INVALID_INPUT');
    const deleted = await chatRepo.deleteSession(req.userId, req.params.id);
    if (!deleted) return sendError(res, 'NOT_FOUND');
    if (fileRepo) {
      await fileRepo.removeSessionRefs(req.userId, req.params.id).catch((error) => {
        console.error('[sessions] remove file refs failed:', error.message);
      });
    }
    return res.json({ ok: true });
  });

  router.delete('/sessions', async (req, res) => {
    const deleted = await chatRepo.clearSessions(req.userId);
    if (fileRepo) {
      await fileRepo.clearRefs(req.userId).catch((error) => {
        console.error('[sessions] clear file refs failed:', error.message);
      });
    }
    return res.json({ ok: true, deleted });
  });

  return router;
}

module.exports = { createSessionRoutes };
