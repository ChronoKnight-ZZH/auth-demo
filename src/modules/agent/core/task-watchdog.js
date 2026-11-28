'use strict';
/**
 * Agent 任务超时兜底（watchdog）。
 *
 * 为什么需要：阶段 1 的执行器只是占位，且 Worker 是独立进程。
 * 出现下列情况时任务会一直停在活动态，前端按 status 轮询永远等不到终态
 * （用户侧表现为「提交智能体任务后长时间无响应」）：
 *   - AGENT_QUEUE_MODE=off：任务只落库，没有任何消费方；
 *   - AGENT_EXECUTION_ENABLED=0：API 不投递、Worker 拒绝启动；
 *   - AGENT_QUEUE_MODE=bullmq 但 Worker 进程没跑 / 崩了；
 *   - 执行器抛错但状态迁移失败，任务卡在 running。
 *
 * 兜底有两处触发点，都走同一套判定：
 *   1) 读时：GET /api/agent/tasks/:id —— 前端正在轮询，立即可见终态；
 *   2) 定时：API 进程内的巡检（仅 AGENT_ENABLED 时启动），没人读也会收场。
 * 迁移一律用条件更新（fromStatuses），不会覆盖并发写入的终态。
 */
const { config } = require('../../../config');
const { TASK_STATUS, ACTIVE_STATUSES, isActiveStatus } = require('../types/agent.types');

/** 没有任何消费方时的宽限期：给 inline/Worker 一点领取时间，超过即判失败，比干等 600s 友好 */
const NO_CONSUMER_GRACE_MS = 10_000;

/**
 * 判定活动态任务是否应当收场。
 * @returns {{code: string, message: string} | null} null = 仍在正常推进
 */
function staleReason(task, { now, queueTimeoutMs, hasConsumer }) {
  if (!task || !isActiveStatus(task.status)) return null;

  // 1) 总时限：以任务上的 deadline_at 为准（Worker 领取时会顺延）
  if (task.deadlineAt && now >= task.deadlineAt) {
    return { code: 'AGENT_TASK_TIMEOUT', message: '任务超过总时限（AGENT_TASK_TIMEOUT_MS）' };
  }

  if (task.status === TASK_STATUS.QUEUED) {
    const queuedMs = now - (task.createdAt || now);
    // 2) 根本没有消费方（queue=off / executor=0）：快速失败，错误码直指配置问题
    if (!hasConsumer && queuedMs >= NO_CONSUMER_GRACE_MS) {
      return {
        code: 'AGENT_NO_CONSUMER',
        message: '没有 Worker 领取任务：请检查 AGENT_ENABLED / AGENT_QUEUE_MODE / AGENT_EXECUTION_ENABLED，或启动 npm run worker:agent',
      };
    }
    // 3) 有生产者在投递但没人消费（bullmq 而 Worker 掉了）：按排队超时收场
    if (queueTimeoutMs > 0 && queuedMs >= queueTimeoutMs) {
      return { code: 'AGENT_QUEUE_TIMEOUT', message: '任务排队超时：Worker 未在期限内领取' };
    }
  }

  return null;
}

/**
 * 对单个任务执行兜底收场；非活动态或未过期时原样返回。
 * 条件迁移失败（说明并发下已被别的路径落终态）时回读最新值。
 */
async function settleTask(taskRepo, task, { now = Date.now(), queueTimeoutMs = config.agent.queueTimeoutMs, hasConsumer = true } = {}) {
  const reason = staleReason(task, { now, queueTimeoutMs, hasConsumer });
  if (!reason) return task;

  const updated = await taskRepo.transitionTask(task.id, ACTIVE_STATUSES, {
    status: TASK_STATUS.TIMED_OUT,
    currentStep: null,
    errorCode: reason.code,
    errorMessage: reason.message,
    finishedAt: now,
    updatedAt: now,
  });
  if (updated) return updated;
  return (await taskRepo.getTaskById(task.id)) || task;
}

/** 仍停留在活动态且已到期的任务 ID（巡检用；两条判定条件合一） */
function staleWhere({ now, queueTimeoutMs, hasConsumer }) {
  const queuedBefore = hasConsumer ? now - queueTimeoutMs : now - NO_CONSUMER_GRACE_MS;
  return {
    statuses: ACTIVE_STATUSES,
    // queued：按排队上限；running / waiting_model：只能靠 deadline_at
    queuedBefore,
    deadlineBefore: now,
  };
}

/**
 * 启动进程内巡检。返回停止函数；AGENT_ENABLED=false 时不应调用。
 * 巡检只是保险：没人轮询任务时也要让过期任务落终态，避免表里堆积活动态行。
 */
function startTaskWatchdog(taskRepo, { hasConsumer, intervalMs = 30_000, limit = 50, logger = console, now = Date.now } = {}) {
  if (typeof taskRepo.findStale !== 'function') return () => {};

  const tick = async () => {
    let ids = [];
    try {
      ids = await taskRepo.findStale(staleWhere({ now: now(), queueTimeoutMs: config.agent.queueTimeoutMs, hasConsumer }));
    } catch (error) {
      logger.warn('[agent-watchdog] 扫描失败:', error.message);
      return;
    }
    for (const id of ids) {
      try {
        const task = await taskRepo.getTaskById(id);
        await settleTask(taskRepo, task, { now: now(), hasConsumer });
      } catch (error) {
        logger.warn(`[agent-watchdog] 任务 ${id} 收场失败:`, error.message);
      }
    }
    if (ids.length) logger.log(`[agent-watchdog] 收场 ${ids.length} 个过期任务`);
  };

  const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  NO_CONSUMER_GRACE_MS,
  staleReason,
  staleWhere,
  settleTask,
  startTaskWatchdog,
};
