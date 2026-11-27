'use strict';
/**
 * 内存 AgentTaskRepository：零依赖模式与单元测试用，语义与 MySQL 实现一致。
 */
const { AgentTaskRepository } = require('./agent-task.repository');

const clone = (value) => JSON.parse(JSON.stringify(value));

class MemoryAgentTaskRepository extends AgentTaskRepository {
  constructor() {
    super();
    /** id -> task */
    this.tasks = new Map();
    /** taskId -> step[] */
    this.steps = new Map();
    /** taskId -> file[] */
    this.files = new Map();
    this.nextStepId = 1;
  }

  async ping() { return true; }

  async createTask(task, files = []) {
    // 与 MySQL UNIQUE(user_id, idempotency_key) 对齐：并发同键由服务层回读已有任务
    if (task.idempotencyKey) {
      for (const existing of this.tasks.values()) {
        if (String(existing.userId) === String(task.userId)
          && existing.idempotencyKey === task.idempotencyKey) {
          const error = new Error('duplicate idempotency key');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
      }
    }
    const row = clone(task);
    this.tasks.set(row.id, row);
    this.steps.set(row.id, []);
    this.files.set(row.id, files.map(clone));
    return clone(row);
  }

  async getTask(userId, id) {
    const task = this.tasks.get(id);
    if (!task || String(task.userId) !== String(userId)) return null;
    return clone(task);
  }

  async getTaskById(id) {
    const task = this.tasks.get(id);
    return task ? clone(task) : null;
  }

  async findByIdempotencyKey(userId, key) {
    if (!key) return null;
    for (const task of this.tasks.values()) {
      if (String(task.userId) === String(userId) && task.idempotencyKey === key) {
        return clone(task);
      }
    }
    return null;
  }

  async transitionTask(id, fromStatuses, patch) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (Array.isArray(fromStatuses) && !fromStatuses.includes(task.status)) return null;
    Object.assign(task, clone(patch));
    task.updatedAt = patch.updatedAt ?? Date.now();
    return clone(task);
  }

  async updateTask(id, patch) {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, clone(patch));
    task.updatedAt = patch.updatedAt ?? Date.now();
    return clone(task);
  }

  async listSteps(taskId) {
    return clone(this.steps.get(taskId) ?? []);
  }

  async appendStep(step) {
    const list = this.steps.get(step.taskId);
    if (!list) return null;
    const index = step.stepIndex == null
      ? list.reduce((max, item) => Math.max(max, item.stepIndex), 0) + 1
      : step.stepIndex;
    const existing = list.find((item) => item.stepIndex === index);
    const row = {
      ...clone(step),
      id: existing ? existing.id : this.nextStepId++,
      stepIndex: index,
    };
    if (existing) {
      Object.assign(existing, row);
      return clone(existing);
    }
    list.push(row);
    return clone(row);
  }

  async updateStep(taskId, stepIndex, patch) {
    const list = this.steps.get(taskId) ?? [];
    const step = list.find((item) => item.stepIndex === stepIndex);
    if (!step) return null;
    Object.assign(step, clone(patch));
    return clone(step);
  }

  async listFiles(taskId) {
    return clone(this.files.get(taskId) ?? []);
  }

  async addFile(file) {
    const list = this.files.get(file.taskId);
    if (!list) return null;
    list.push(clone(file));
    return clone(file);
  }

  async close() {
    this.tasks.clear();
    this.steps.clear();
    this.files.clear();
  }
}

module.exports = { MemoryAgentTaskRepository };
