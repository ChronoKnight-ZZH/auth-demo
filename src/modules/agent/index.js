'use strict';
/**
 * Agent 模块装配。
 *
 * API 进程只创建任务仓储、服务和 BullMQ 生产者；Worker 在独立进程启动。
 * AGENT_ENABLED=0 时仍会创建仓储（内存/MySQL），但路由会被功能闸拒绝。
 */
const { config } = require('../../config');
const { createAgentFeatureGate } = require('./api/agent.feature-gate');
const { createAgentController } = require('./api/agent.controller');
const { createAgentRoutes } = require('./api/agent.routes');
const { createCreateTaskService } = require('./application/create-task.service');
const { createGetTaskService } = require('./application/get-task.service');
const { createCancelTaskService } = require('./application/cancel-task.service');
const { createAgentQueue } = require('./queue/agent-queue');
const { runAgentTask } = require('./core/agent-loop');
const { startTaskWatchdog } = require('./core/task-watchdog');

function createAgentModule({ taskRepo, fileRepo, chatRepo, authenticate }) {
  const featureGate = createAgentFeatureGate();
  const queue = config.agent.enabled
    && config.agent.executionEnabled
    && config.agent.queueMode !== 'off'
    ? createAgentQueue({
      mode: config.agent.queueMode,
      redisUrl: config.redis.url,
      name: config.agent.queueName,
      prefix: config.agent.queuePrefix,
      enqueueTimeoutMs: config.agent.queueEnqueueTimeoutMs,
      handler: (taskId) => runAgentTask(taskId, { taskRepo }),
    })
    : null;

  /**
   * 是否有消费方：
   *   - inline：本进程就是执行者；
   *   - bullmq：生产者在这里，真正的 Worker 是独立进程，探测不到 → 交给排队上限兜底；
   *   - queue 为 null（off / executor=0）：没人会领取，10s 宽限期后直接判失败。
   */
  const hasConsumer = Boolean(queue);
  const getTaskService = createGetTaskService({
    taskRepo,
    queueTimeoutMs: config.agent.queueTimeoutMs,
    hasConsumer,
  });

  const createTask = createCreateTaskService({ taskRepo, fileRepo, chatRepo, queue });
  const cancelTask = createCancelTaskService({ taskRepo });
  const controller = createAgentController({
    createTask,
    getTaskService,
    cancelTask,
    featureGate,
  });
  const routes = createAgentRoutes({ controller, authenticate, featureGate });

  // 巡检：没人轮询任务时也要让过期任务落终态，避免活动态行堆积
  const stopWatchdog = config.agent.enabled
    ? startTaskWatchdog(taskRepo, { hasConsumer })
    : () => {};

  return {
    routes,
    queue,
    featureGate,
    /** /health 用：前端据此判断「提交了也没人执行」，避免用户干等 */
    status: {
      enabled: config.agent.enabled,
      queueMode: config.agent.queueMode,
      executionEnabled: config.agent.executionEnabled,
      allowlistSize: config.agent.allowlist.length,
      hasConsumer,
    },
    async close() {
      stopWatchdog();
      if (queue) await queue.close();
    },
  };
}

module.exports = { createAgentModule };
