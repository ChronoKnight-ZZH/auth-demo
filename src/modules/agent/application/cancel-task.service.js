'use strict';
/**
 * 取消 Agent 任务。
 *
 * 只做状态迁移，不在这里直接杀容器或中断模型请求；Worker 在每一步开始前
 * 读取任务状态，发现 cancelled 即停止。终态任务重复取消返回 cancelled=false。
 */
const { AppError } = require('../../../lib/errors');
const { TASK_STATUS, ACTIVE_STATUSES, isTerminalStatus } = require('../types/agent.types');

function createCancelTaskService({ taskRepo, now = Date.now }) {
  return async function cancelTask(userId, taskId) {
    const task = await taskRepo.getTask(userId, taskId);
    if (!task) throw new AppError('AGENT_TASK_NOT_FOUND');

    if (isTerminalStatus(task.status)) {
      return { cancelled: false, task };
    }

    const updated = await taskRepo.transitionTask(task.id, ACTIVE_STATUSES, {
      status: TASK_STATUS.CANCELLED,
      currentStep: null,
      finishedAt: now(),
      updatedAt: now(),
    });

    if (!updated) {
      // 并发下任务可能已经进入终态：返回最新状态，不视为错误
      const current = await taskRepo.getTask(userId, taskId);
      if (!current) throw new AppError('AGENT_TASK_NOT_FOUND');
      return { cancelled: false, task: current };
    }

    return { cancelled: true, task: updated };
  };
}

module.exports = { createCancelTaskService };
