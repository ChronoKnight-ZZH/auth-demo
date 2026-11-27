'use strict';
/**
 * Agent Loop 入口（阶段 1 占位）。
 *
 * 阶段 1 只负责领取任务并验证状态机；模型循环与 Docker 执行器在阶段 2/3
 * 接入。executionEnabled=false 时 Worker 不应启动，避免任务被误消费。
 */
const { AppError } = require('../../../lib/errors');
const { config } = require('../../../config');
const { TASK_STATUS } = require('../types/agent.types');

function errorCodeOf(error) {
  if (error instanceof AppError) return error.code;
  if (error && typeof error.code === 'string') return error.code;
  return 'AGENT_EXECUTOR_UNAVAILABLE';
}

async function runAgentTask(taskId, { taskRepo, logger = console }) {
  if (!config.agent.executionEnabled) {
    throw new AppError('AGENT_EXECUTOR_UNAVAILABLE');
  }

  const now = Date.now();
  const claimed = await taskRepo.transitionTask(taskId, [TASK_STATUS.QUEUED], {
    status: TASK_STATUS.RUNNING,
    startedAt: now,
    // 超时从真正开始执行时计算，排队时间不计入 600s
    deadlineAt: now + config.agent.taskTimeoutMs,
    currentStep: 'agent_loop',
    updatedAt: now,
  });

  // 已被其他 Worker 领取、已取消或已终态：直接结束，不重复执行
  if (!claimed) return null;

  try {
    // TODO(阶段 2)：Anthropic Messages 工具调用循环
    // TODO(阶段 3)：Docker Python 执行器
    throw new AppError('AGENT_EXECUTOR_UNAVAILABLE');
  } catch (error) {
    const code = errorCodeOf(error);
    logger.error(`[agent] task ${taskId} failed: ${code} ${error.message}`);
    // 条件迁移：用户已取消或任务已超时时，不能被失败覆盖
    await taskRepo.transitionTask(taskId, [TASK_STATUS.RUNNING, TASK_STATUS.WAITING_MODEL], {
      status: TASK_STATUS.FAILED,
      currentStep: null,
      errorCode: code,
      errorMessage: String(error.message || '').slice(0, 1000),
      finishedAt: Date.now(),
    });
    return null;
  }
}

module.exports = { runAgentTask };
