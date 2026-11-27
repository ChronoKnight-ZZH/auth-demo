'use strict';
/**
 * Agent Worker 独立入口。
 *
 * 与 API 进程分离：API 只写 MySQL + 投递 BullMQ；本进程负责消费任务。
 * 阶段 1 只搭骨架，AGENT_EXECUTION_ENABLED=0 时拒绝启动，避免任务被
 * 误消费后直接标记失败。
 *
 * 启动前置条件（任一不满足直接退出，由 systemd 负责重试/告警）：
 *   - AGENT_ENABLED=1
 *   - AGENT_QUEUE_MODE=bullmq
 *   - AGENT_EXECUTION_ENABLED=1
 *   - REDIS_URL / MYSQL_URL 均已配置
 *
 * 运行：node src/workers/agent.worker.js
 */
require('../lib/load-env').loadEnv();
const { config } = require('../config');

function refuse(reason) {
  console.error(`[agent-worker] 拒绝启动：${reason}`);
  process.exitCode = 1;
}

async function main() {
  if (!config.agent.enabled) return refuse('AGENT_ENABLED 未开启');
  if (config.agent.queueMode !== 'bullmq') {
    return refuse(`AGENT_QUEUE_MODE=${config.agent.queueMode}，Worker 只在 bullmq 模式下运行`);
  }
  if (!config.agent.executionEnabled) {
    return refuse('AGENT_EXECUTION_ENABLED 未开启（阶段 1 不执行任务）');
  }
  if (!config.redis.url) return refuse('REDIS_URL 未配置');
  if (!config.mysql.url) return refuse('MYSQL_URL 未配置（任务状态以 MySQL 为准）');

  const { MysqlAgentTaskRepository } = require('../modules/agent/repositories/mysql-agent-task.repository');
  const { createAgentWorker } = require('../modules/agent/queue/agent-queue');
  const { runAgentTask } = require('../modules/agent/core/agent-loop');

  const taskRepo = new MysqlAgentTaskRepository();
  try {
    await taskRepo.ping();
  } catch (error) {
    await taskRepo.close().catch(() => {});
    return refuse(`Agent 任务存储连接失败：${error.message}`);
  }

  const worker = createAgentWorker({
    redisUrl: config.redis.url,
    name: config.agent.queueName,
    prefix: config.agent.queuePrefix,
    concurrency: config.agent.workerConcurrency,
    handler: (taskId) => runAgentTask(taskId, { taskRepo }),
  });

  console.log(
    `[agent-worker] started queue=${config.agent.queuePrefix}:${config.agent.queueName} `
    + `concurrency=${config.agent.workerConcurrency}`
  );

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[agent-worker] ${signal} received, shutting down...`);
    try {
      await worker.close();
    } finally {
      await taskRepo.close().catch(() => {});
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}

main().catch((error) => {
  console.error('[agent-worker] fatal:', error && error.stack ? error.stack : error);
  process.exit(1);
});
