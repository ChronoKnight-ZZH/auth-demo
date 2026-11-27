'use strict';
/**
 * Agent API 参数校验。
 *
 * 只接受明确字段，未知字段忽略；所有 ID 先按固定字符集校验，避免把
 * 任意字符串带进仓储层或后续文件路径。
 */
const { AppError } = require('../../../lib/errors');
const { config } = require('../../../config');

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** 全局 JSON 解析上限是 16kb，这里留出 JSON 结构余量 */
const MAX_MESSAGE_BYTES = 12 * 1024;

function invalid() {
  return new AppError('INVALID_INPUT');
}

function parseTaskId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw invalid();
  return value;
}

function parseIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !IDEMPOTENCY_RE.test(value.trim())) throw invalid();
  return value.trim();
}

function parseCreateTask(body, headers = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();

  const rawMessage = body.message;
  if (typeof rawMessage !== 'string') throw invalid();
  const message = rawMessage.trim();
  if (!message) throw invalid();
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE');
  }

  let conversationId = null;
  if (body.conversation_id !== undefined && body.conversation_id !== null) {
    if (typeof body.conversation_id !== 'string' || !ID_RE.test(body.conversation_id)) {
      throw invalid();
    }
    conversationId = body.conversation_id;
  }

  const rawFileIds = body.file_ids === undefined ? [] : body.file_ids;
  if (!Array.isArray(rawFileIds)) throw invalid();
  if (rawFileIds.length > config.agent.maxInputFiles) throw invalid();

  const fileIds = [];
  for (const id of rawFileIds) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid();
    if (!fileIds.includes(id)) fileIds.push(id);
  }

  const idempotencyKey = parseIdempotencyKey(headers['idempotency-key']);

  return { message, conversationId, fileIds, idempotencyKey };
}

module.exports = {
  ID_RE,
  IDEMPOTENCY_RE,
  MAX_MESSAGE_BYTES,
  parseTaskId,
  parseIdempotencyKey,
  parseCreateTask,
};
