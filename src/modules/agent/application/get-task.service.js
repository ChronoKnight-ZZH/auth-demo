'use strict';
/**
 * 查询 Agent 任务、步骤和文件。
 * 所有入口先按 userId + taskId 校验归属，跨用户统一 404。
 */
const { AppError } = require('../../../lib/errors');

function createGetTaskService({ taskRepo }) {
  async function requireTask(userId, taskId) {
    const task = await taskRepo.getTask(userId, taskId);
    if (!task) throw new AppError('AGENT_TASK_NOT_FOUND');
    return task;
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
