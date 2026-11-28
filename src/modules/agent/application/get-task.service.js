'use strict';
/**
 * 查询 Agent 任务、步骤和文件。
 * 所有入口先按 userId + taskId 校验归属，跨用户统一 404。
 *
 * 读时会做一次超时兜底（见 core/task-watchdog）：前端正在轮询，
 * 过期任务应当在本次响应里就落到终态，而不是让轮询一直等下去。
 */
const { AppError } = require('../../../lib/errors');
const { settleTask } = require('../core/task-watchdog');

function createGetTaskService({
  taskRepo,
  now = Date.now,
  queueTimeoutMs,
  hasConsumer = true,
}) {
  async function requireTask(userId, taskId) {
    const task = await taskRepo.getTask(userId, taskId);
    if (!task) throw new AppError('AGENT_TASK_NOT_FOUND');
    // 兜底：活动态但已过期（没人消费 / 排队超时 / 总时限已到）→ 本次读即收场
    return settleTask(taskRepo, task, { now: now(), queueTimeoutMs, hasConsumer });
  }

  async function getTask(userId, taskId) {
    const task = await requireTask(userId, taskId);
    const [steps, files] = await Promise.all([
      taskRepo.listSteps(task.id),
      taskRepo.listFiles(task.id),
    ]);
    return { task, steps, files };
  }

  async function listSteps(userId, taskId) {
    const task = await requireTask(userId, taskId);
    return taskRepo.listSteps(task.id);
  }

  async function listFiles(userId, taskId) {
    const task = await requireTask(userId, taskId);
    return taskRepo.listFiles(task.id);
  }

  async function getFile(userId, taskId, fileId) {
    const files = await listFiles(userId, taskId);
    const file = files.find((item) => item.fileId === fileId || item.id === fileId);
    if (!file) throw new AppError('AGENT_TASK_NOT_FOUND');
    return file;
  }

  return { getTask, listSteps, listFiles, getFile };
}

module.exports = { createGetTaskService };
