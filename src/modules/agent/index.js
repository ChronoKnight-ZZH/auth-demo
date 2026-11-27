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

function createAgentModule({ taskRepo, fileRepo, chatRepo, authenticate }) {
  const featureGate = createAgentFeatureGate();
  const getTaskService = createGetTaskService({ taskRepo });

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

  const createTask = createCreateTaskService({ taskRepo, fileRepo, chatRepo, queue });
  const cancelTask = createCancelTaskService({ taskRepo });
  const controller = createAgentController({
    createTask,
    getTaskService,
    cancelTask,
    featureGate,
  });
  const routes = createAgentRoutes({ controller, authenticate, featureGate });

  return {
    routes,
    queue,
    featureGate,
    async close() {
      if (queue) await queue.close();
    },
  };
}

module.exports = { createAgentModule };
