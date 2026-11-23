'use strict';
/**
 * 文件与语音代理：浏览器不再持有上游 API Key。
 *
 * 这一阶段只做透传，不做服务端持久化：
 *   - POST   /v1/files             → 上游 Files API（原样 multipart）
 *   - DELETE /v1/files/:fileId     → 上游 Files API
 *   - POST   /v1/tools/asr         → 上游 ASR（原样 multipart）
 *   - POST   /v1/tools/tts         → 上游 TTS（二进制流透传）
 *
 * 持久化（附件原件落盘、跨设备读取）在下一阶段实现。
 */
const express = require('express');
const { Readable } = require('node:stream');
const { config } = require('../config');
const { sendError } = require('../lib/errors');

const FILES_BETA = 'files-api-2025-04-14';
const FILE_LIMIT = '64mb';
const ASR_LIMIT = '8mb';
const TTS_LIMIT = '1mb';

/**
 * Web ReadableStream → Node Readable。
 * Node 17+ 用内置 Readable.fromWeb；Node 16 没有该方法，按背压手动拉取。
 */
function toNodeReadable(webStream) {
  if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(webStream);
  return Readable.from((async function* () {
    const reader = webStream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.isBuffer(value) ? value : Buffer.from(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* 已释放 */ }
      try { await webStream.cancel(); } catch { /* 已结束 */ }
    }
  })());
}

function upstreamHeaders(req, { files = false, json = false } = {}) {
  const headers = { Authorization: `Bearer ${config.upstream.apiKey}` };
  if (files) {
    // 兼容上游同时接受 x-api-key 与 Bearer；Files API 需要 beta 头
    headers['x-api-key'] = config.upstream.apiKey;
    headers['anthropic-beta'] = req.headers['anthropic-beta'] || FILES_BETA;
  }
  if (json) {
    headers['Content-Type'] = 'application/json';
  } else if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }
  headers.Accept = req.headers.accept || '*/*';
  return headers;
}

function upstreamErrorCode(status) {
  if (status === 401 || status === 403) return 'UPSTREAM_REJECTED';
  if (status === 429) return 'UPSTREAM_RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'UPSTREAM_REJECTED';
}

async function forward(req, res, { path, method = 'POST', body, files = false, json = false, stream = false }) {
  if (!config.upstream.apiKey) {
    return sendError(res, 'UPSTREAM_NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('upstream total timeout')),
    config.upstream.totalTimeoutMs
  );
  timer.unref?.();

  const onClientClose = () => {
    if (!res.writableEnded) controller.abort(new Error('client closed'));
  };
  res.once('close', onClientClose);

  let response;
  try {
    response = await fetch(config.upstream.baseUrl + path, {
      method,
      headers: upstreamHeaders(req, { files, json }),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    res.off('close', onClientClose);
    if (res.destroyed) return;
    const aborted = controller.signal.aborted;
    return sendError(res, aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR');
  }

  if (!response.ok) {
    clearTimeout(timer);
    res.off('close', onClientClose);
    await response.body?.cancel().catch(() => {});
    return sendError(res, upstreamErrorCode(response.status));
  }

  if (stream) {
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'no-store');
    const done = () => {
      clearTimeout(timer);
      res.off('close', onClientClose);
    };
    res.once('finish', done);
    try {
      toNodeReadable(response.body).pipe(res);
    } catch {
      done();
      res.destroy();
    }
    return;
  }

  let text;
  try {
    text = await response.text();
  } catch {
    clearTimeout(timer);
    res.off('close', onClientClose);
    if (res.destroyed) return;
    return sendError(res, 'UPSTREAM_ERROR');
  }
  clearTimeout(timer);
  res.off('close', onClientClose);
  const contentType = response.headers.get('content-type') || 'application/json';
  res.status(response.status).setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(text);
}

function createProxyRoutes({ authenticate }) {
  const router = express.Router();

  router.post(
    '/files',
    authenticate,
    express.raw({ type: () => true, limit: FILE_LIMIT }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return sendError(res, 'INVALID_INPUT');
      }
      return forward(req, res, {
        path: config.upstream.filesPath,
        body: req.body,
        files: true,
      });
    }
  );

  router.delete('/files/:fileId', authenticate, async (req, res) => {
    const fileId = req.params.fileId;
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) {
      return sendError(res, 'INVALID_INPUT');
    }
    return forward(req, res, {
      path: `${config.upstream.filesPath}/${encodeURIComponent(fileId)}`,
      method: 'DELETE',
      files: true,
    });
  });

  router.post(
    '/tools/asr',
    authenticate,
    express.raw({ type: () => true, limit: ASR_LIMIT }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return sendError(res, 'INVALID_INPUT');
      }
      return forward(req, res, { path: config.upstream.asrPath, body: req.body });
    }
  );

  router.post(
    '/tools/tts',
    authenticate,
    express.raw({ type: () => true, limit: TTS_LIMIT }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return sendError(res, 'INVALID_INPUT');
      }
      return forward(req, res, {
        path: config.upstream.ttsPath,
        body: req.body,
        json: true,
        stream: true,
      });
    }
  );

  return router;
}

module.exports = { createProxyRoutes };
