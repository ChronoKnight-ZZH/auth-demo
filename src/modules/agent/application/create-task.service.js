'use strict';
/**
 * 创建 Agent 任务。
 *
 * 顺序很重要：
 *   1) 幂等键命中直接返回已有任务；
 *   2) 校验会话归属；
 *   3) 逐个校验文件归属并保存授权快照；
 *   4) 先落库，再投递队列。
 *
 * 队列投递失败不回滚任务：任务已持久化为 queued，后续可由 Worker/巡检接管，
 * 避免“数据库已写入但接口报错”导致用户重复提交。
 */
const crypto = require('node:crypto');
const { AppError } = require('../../../lib/errors');
const { config } = require('../../../config');
const { TASK_STATUS, FILE_ROLE } = require('../types/agent.types');

function createCreateTaskService({
  taskRepo,
  fileRepo,
  chatRepo,
  queue = null,
  now = Date.now,
  idFactory = crypto.randomUUID,
  logger = console,
}) {
  return async function createTask(userId, input) {
    if (input.idempotencyKey) {
      const existing = await taskRepo.findByIdempotencyKey(userId, input.idempotencyKey);
      if (existing) return existing;
    }

    if (input.conversationId && chatRepo) {
      const session = await chatRepo.getSession(userId, input.conversationId);
      if (!session) throw new AppError('NOT_FOUND');
    }

    if (input.fileIds.length > config.agent.maxInputFiles) {
      throw new AppError('INVALID_INPUT');
    }

    const taskId = idFactory();
    const createdAt = now();
    const files = [];
    let inputBytes = 0;

    for (const fileId of input.fileIds) {
      if (!fileRepo) throw new AppError('FILES_DISABLED');
      const file = await fileRepo.get(userId, fileId);
      if (!file) throw new AppError('FILE_ACCESS_DENIED');
      const fileBytes = Number(file.size) || 0;
      if (fileBytes > config.files.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
      inputBytes += fileBytes;
      files.push({
        id: idFactory(),
        taskId,
        userId,
        fileId: file.id,
        fileRole: FILE_ROLE.INPUT,
        fileName: file.name,
        fileType: file.mime,
        fileSize: fileBytes,
        downloadUrl: null,
        createdAt,
      });
    }

    if (inputBytes > config.agent.maxInputBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE');
    }

    const task = {
      id: taskId,
      userId,
      conversationId: input.conversationId,
      status: TASK_STATUS.QUEUED,
      inputText: input.message,
      currentStep: null,
      resultText: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: input.idempotencyKey,
      modelCalls: 0,
      toolCalls: 0,
      deadlineAt: createdAt + config.agent.taskTimeoutMs,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };

    let created;
    try {
      created = await taskRepo.createTask(task, files);
    } catch (error) {
      // 并发提交同一幂等键：唯一索引冲突后回读已有任务
      if (error && error.code === 'ER_DUP_ENTRY' && input.idempotencyKey) {
        const existing = await taskRepo.findByIdempotencyKey(userId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }

    if (queue) {
      try {
        await queue.enqueue(created.id);
      } catch (error) {
        logger.error('[agent] enqueue failed:', error.message);
      }
    }

    return created;
  };
}

module.exports = { createCreateTaskService };
