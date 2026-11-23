'use strict';
/**
 * 附件原件路由（里程碑 3）。
 *
 *   POST   /files/originals                 流式上传原件（登录态 / HttpOnly Cookie）
 *   GET    /files/originals/:id/url         按会话签发 p/r 票据（登录态 / HttpOnly Cookie）
 *   DELETE /files/originals/:id             软删除原件（登录态 / HttpOnly Cookie）
 *   GET    /files/content?file_id&state&ty  凭票据读取原件（无需 Cookie/Header）
 *
 * `/files/content` 走查询票据而非 Cookie，是因为 <img src>/<a download> 在分域部署下
 * 不一定能带上 HttpOnly Cookie（跨源/第三方 Cookie 限制）。票据本身是能力凭证：
 * 绑定 uid + sid，读取时仍会回查文件归属与会话存活，越权与不存在统一返回 404。
 */
const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const express = require('express');
const { config } = require('../config');
const { sendError } = require('../lib/errors');
const blobStore = require('../files/blob-store');
const fileToken = require('../files/token');
const mimeSniff = require('../files/mime');
const textFile = require('../files/text');

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TYPES = new Set(['t', 'p', 'r']);

function decodeHeader(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function cleanName(raw, fallback = 'file') {
  const name = typeof raw === 'string' ? raw : '';
  // 去掉路径、控制字符和引号，避免响应头注入与路径穿越
  const base = name.split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return [...(cleaned || fallback)].slice(0, 255).join('');
}

function asciiFallback(name) {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
}

function contentDisposition(file, inline) {
  const kind = inline ? 'inline' : 'attachment';
  const name = cleanName(file.name);
  // RFC 5987 attr-char：encodeURIComponent 未转义的 '()*! 需要补上
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${kind}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encoded}`;
}

function parseQuery(value) {
  return typeof value === 'string' ? value : '';
}

function createFileRoutes({ fileRepo, chatRepo, authenticate }) {
  const router = express.Router();
  const enabled = config.files.mode === 'local';

  router.post('/files/originals', authenticate, async (req, res) => {
    if (!enabled) return sendError(res, 'FILES_DISABLED');

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > config.files.maxBytes) {
      return sendError(res, 'PAYLOAD_TOO_LARGE');
    }
    const declaredMime = mimeSniff.sanitizeDeclared(req.headers['x-file-mime']);
    const name = cleanName(decodeHeader(req.headers['x-file-name']));

    let uploaded;
    try {
      uploaded = await blobStore.putStream(req, { limit: config.files.maxBytes });
    } catch (error) {
      if (error.code === 'FILE_TOO_LARGE') return sendError(res, 'PAYLOAD_TOO_LARGE');
      if (res.destroyed) return undefined;
      throw error;
    }

    if (uploaded.size === 0) {
      await fsPromises.rm(uploaded.tmp, { force: true }).catch(() => {});
      return sendError(res, 'INVALID_INPUT');
    }

    const { mime, isImage } = await mimeSniff.detect(uploaded.tmp, { name, declared: declaredMime });
    const committed = await blobStore.commit(
      uploaded.tmp,
      uploaded.sha256,
      uploaded.size,
      req.userId
    );
    const file = await fileRepo.create(req.userId, {
      id: crypto.randomUUID(),
      sha256: committed.sha256,
      storageKey: committed.storageKey,
      size: uploaded.size,
      mime,
      name,
      isImage,
      createdAt: Date.now(),
    });

    return res.status(201).json({
      fileId: file.id,
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      name: file.name,
      isImage: file.isImage,
    });
  });

  router.get('/files/originals/:id/url', authenticate, async (req, res) => {
    if (!enabled) return sendError(res, 'FILES_DISABLED');
    if (!ID_RE.test(req.params.id)) return sendError(res, 'INVALID_INPUT');
    const sessionId = parseQuery(req.query.sessionId);
    if (!ID_RE.test(sessionId)) return sendError(res, 'INVALID_INPUT');

    const session = await chatRepo.getSession(req.userId, sessionId);
    if (!session) return sendError(res, 'FILE_ACCESS_DENIED');
    const file = await fileRepo.get(req.userId, req.params.id);
    if (!file) return sendError(res, 'FILE_ACCESS_DENIED');

    const urls = Object.fromEntries(
      [...TYPES].map((type) => [
        type,
        fileToken.issue({
          fileId: file.id,
          userId: req.userId,
          sessionId,
          type,
        }),
      ])
    );
    return res.json({
      urls,
      expiresAt: Date.now() + config.files.tokenTtlMs,
      mime: file.mime,
      name: file.name,
      isImage: file.isImage,
    });
  });

  router.delete('/files/originals/:id', authenticate, async (req, res) => {
    if (!enabled) return sendError(res, 'FILES_DISABLED');
    if (!ID_RE.test(req.params.id)) return sendError(res, 'INVALID_INPUT');
    const deleted = await fileRepo.softDelete(req.userId, req.params.id);
    if (!deleted) return sendError(res, 'NOT_FOUND');
    return res.json({ ok: true });
  });

  // 票据读取：不挂 authenticate，由 state 提供能力凭证
  router.get('/files/content', async (req, res) => {
    if (!enabled) return sendError(res, 'FILES_DISABLED');

    const claims = fileToken.verify(parseQuery(req.query.state));
    if (!claims) return sendError(res, 'FILE_TOKEN_INVALID');

    const fileId = parseQuery(req.query.file_id);
    const type = parseQuery(req.query.ty);
    if (fileId !== claims.fid || type !== claims.ty || !TYPES.has(type)) {
      return sendError(res, 'FILE_TOKEN_INVALID');
    }

    // 会话必须仍然存活且属于票据中的用户；删除会话后文件立即不可取
    const session = await chatRepo.getSession(claims.uid, claims.sid);
    if (!session) return sendError(res, 'FILE_ACCESS_DENIED');

    const file = await fileRepo.get(claims.uid, claims.fid);
    if (!file) return sendError(res, 'FILE_ACCESS_DENIED');

    const blob = await blobStore.stat(file.storageKey);
    if (!blob) return sendError(res, 'FILE_ACCESS_DENIED');

    // 公共安全头：文本与图片都内联返回，必须禁止嗅探与脚本执行
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex');
    // 分域部署（chat.X 页面内嵌 api.X 图片）时 same-origin 会被 CORP 拦死；
    // 由 FILES_CORP / CORS_ORIGINS 决定，见 config.files.corp
    res.setHeader('Cross-Origin-Resource-Policy', config.files.corp);

    // 文本预览：服务端统一转 UTF-8 后以 text/plain 内联，避免浏览器把
    // .txt/.md/.csv 等当附件下载。仅 p/t 票据；r 票据保持下载语义。
    // 转码会改变字节长度，因此这条路径不提供 Range，ETag 带上编码标记。
    if (type !== 'r' && mimeSniff.isTextual(file.mime) && blob.size <= config.files.textMaxBytes) {
      const prepared = await textFile.transcodeToUtf8(blob.path, {
        maxBytes: config.files.textMaxBytes,
      });
      if (prepared) {
        const etag = `"${file.sha256}-${file.size}-${prepared.encoding}"`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition(file, true));
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          return res.status(304).end();
        }
        res.setHeader('Content-Length', String(prepared.body.length));
        return res.end(prepared.body);
      }
      // 读取失败或超限：退回下面的附件下载语义
    }

    const inlineImage = type !== 'r' && mimeSniff.isInlineImage(file.mime);
    res.setHeader('Content-Type', inlineImage ? file.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(file, inlineImage));
    // 下载不缓存；内联图片缓存 60s，删除会话后最多 1 分钟内仍可能命中浏览器缓存
    res.setHeader('Cache-Control', type === 'r' ? 'private, no-store' : 'private, max-age=60');
    res.setHeader('ETag', `"${file.sha256}-${file.size}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.headers['if-none-match'] === `"${file.sha256}-${file.size}"`) {
      return res.status(304).end();
    }

    const range = blobStore.parseRange(req.headers.range, file.size);
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.status(200);
      res.setHeader('Content-Length', String(file.size));
    }

    const stream = blobStore.createReadStream(file.storageKey, range ?? undefined);
    stream.on('error', () => {
      if (!res.headersSent) {
        sendError(res, 'FILE_ACCESS_DENIED');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
    return undefined;
  });

  return router;
}

module.exports = { createFileRoutes };
