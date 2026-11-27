'use strict';
/**
 * Agent 任务持久化接口。
 *
 * 实现必须保证：
 *   1) 所有用户侧查询同时带 userId，跨用户访问返回 null；
 *   2) 状态迁移带 fromStatuses 条件，避免并发覆盖终态；
 *   3) 任务、步骤、文件写入失败时整体回滚（MySQL 实现使用事务）。
 */

class AgentTaskRepository {
  /* eslint-disable no-unused-vars */
  async ping() { throw new Error('not implemented'); }

  /** 创建任务并写入输入文件授权快照（同一事务） */
  async createTask(task, files = []) { throw new Error('not implemented'); }

  async getTask(userId, id) { throw new Error('not implemented'); }
  async getTaskById(id) { throw new Error('not implemented'); }
  async findByIdempotencyKey(userId, key) { throw new Error('not implemented'); }

  /**
   * 条件迁移：仅当当前状态在 fromStatuses 中才更新。
   * @returns {Promise<object|null>} 更新后的任务；条件不满足返回 null
   */
  async transitionTask(id, fromStatuses, patch) { throw new Error('not implemented'); }

  /** 无条件更新（Worker 内部记录计数、错误摘要等），调用方自行保证状态语义 */
  async updateTask(id, patch) { throw new Error('not implemented'); }

  async listSteps(taskId) { throw new Error('not implemented'); }
  async appendStep(step) { throw new Error('not implemented'); }
  async updateStep(taskId, stepIndex, patch) { throw new Error('not implemented'); }

  async listFiles(taskId) { throw new Error('not implemented'); }
  async addFile(file) { throw new Error('not implemented'); }

  async close() {}
  /* eslint-enable no-unused-vars */
}

module.exports = { AgentTaskRepository };
