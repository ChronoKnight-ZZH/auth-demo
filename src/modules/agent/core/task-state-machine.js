'use strict';
/**
 * Agent 任务状态机。
 *
 * 所有状态迁移必须经过这里，禁止在路由或 Worker 中直接写 status。
 * 终态不可回退，保证取消、超时和失败不会被普通重试覆盖。
 */
const { AppError } = require('../../../lib/errors');
const {
  TASK_STATUS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  isTerminalStatus,
  isActiveStatus,
} = require('../types/agent.types');

const TRANSITIONS = Object.freeze({
  [TASK_STATUS.QUEUED]: Object.freeze([
    TASK_STATUS.RUNNING,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
  ]),
  [TASK_STATUS.RUNNING]: Object.freeze([
    TASK_STATUS.WAITING_MODEL,
    TASK_STATUS.COMPLETED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.TIMED_OUT,
  ]),
  [TASK_STATUS.WAITING_MODEL]: Object.freeze([
    TASK_STATUS.RUNNING,
    TASK_STATUS.COMPLETED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.TIMED_OUT,
  ]),
  [TASK_STATUS.COMPLETED]: Object.freeze([]),
  [TASK_STATUS.FAILED]: Object.freeze([]),
  [TASK_STATUS.CANCELLED]: Object.freeze([]),
  [TASK_STATUS.TIMED_OUT]: Object.freeze([]),
});

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new AppError('AGENT_INVALID_STATE');
    error.from = from;
    error.to = to;
    throw error;
  }
}

/** Worker 领取任务：只允许 queued → running */
function claimPatch(now) {
  return {
    status: TASK_STATUS.RUNNING,
    startedAt: now,
    updatedAt: now,
  };
}

module.exports = {
  TRANSITIONS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  canTransition,
  assertTransition,
  claimPatch,
  isTerminalStatus,
  isActiveStatus,
};
