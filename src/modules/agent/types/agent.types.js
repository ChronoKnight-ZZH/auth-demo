'use strict';
/**
 * Agent 领域常量与类型说明。
 *
 * 第一阶段只定义任务、步骤、文件三种实体；执行器、模型客户端和 Docker
 * 容器在后续阶段接入。所有持久化字段使用 camelCase，数据库列使用 snake_case。
 */

const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_MODEL: 'waiting_model',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
});

/** 终态：不可再迁移，Worker 不得重复执行 */
const TERMINAL_STATUSES = Object.freeze([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.TIMED_OUT,
]);

/** 活动态：可以被取消、超时或继续执行 */
const ACTIVE_STATUSES = Object.freeze([
  TASK_STATUS.QUEUED,
  TASK_STATUS.RUNNING,
  TASK_STATUS.WAITING_MODEL,
]);

const STEP_TYPE = Object.freeze({
  MODEL: 'model',
  TOOL: 'tool',
});

const STEP_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const FILE_ROLE = Object.freeze({
  INPUT: 'input',
  OUTPUT: 'output',
  INTERMEDIATE: 'intermediate',
});

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * @typedef {object} AgentTask
 * @property {string} id
 * @property {number|string} userId
 * @property {string|null} conversationId
 * @property {string} status
 * @property {string} inputText
 * @property {string|null} currentStep
 * @property {string|null} resultText
 * @property {string|null} errorCode
 * @property {string|null} errorMessage
 * @property {string|null} idempotencyKey
 * @property {number} modelCalls
 * @property {number} toolCalls
 * @property {number|null} deadlineAt
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {object} AgentTaskStep
 * @property {number|string} id
 * @property {string} taskId
 * @property {number} stepIndex
 * @property {string} stepType
 * @property {string|null} toolName
 * @property {string} status
 * @property {string|null} inputSummary
 * @property {string|null} outputSummary
 * @property {string|null} errorCode
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {number|null} durationMs
 * @property {number} createdAt
 */

/**
 * @typedef {object} AgentTaskFile
 * @property {string} id
 * @property {string} taskId
 * @property {number|string} userId
 * @property {string|null} fileId
 * @property {string} fileRole
 * @property {string} fileName
 * @property {string} fileType
 * @property {number} fileSize
 * @property {string|null} downloadUrl
 * @property {number} createdAt
 */

module.exports = {
  TASK_STATUS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  STEP_TYPE,
  STEP_STATUS,
  FILE_ROLE,
  isTerminalStatus,
  isActiveStatus,
};
