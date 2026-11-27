'use strict';
/**
 * BullMQ 生产者与 Worker 工厂。
 *
 * 生产者只创建 Queue，不创建 Worker；Worker 只在独立进程
 * src/workers/agent.worker.js 中创建，避免 API 进程消费任务。
 *
 * inline 模式仅用于本地开发/测试：不经过 Redis，直接在进程内调用 handler。
 */
function createAgentQueue({
  mode,
  redisUrl,
  name,
  prefix,
  handler,
  enqueueTimeoutMs = 3_000,
}) {
  if (mode === 'off') return null;

  if (mode === 'inline') {
    if (typeof handler !== 'function') throw new Error('inline 队列需要 handler');
    return {
      mode,
      async enqueue(taskId) {
        setImmediate(() => {
          Promise.resolve()
            .then(() => handler(taskId))
            .catch((error) => {
              // eslint-disable-next-line no-console
              console.error('[agent-queue] inline task failed:', error.message);
            });
        });
      },
      async close() {},
    };
  }

  if (mode !== 'bullmq') throw new Error(`不支持的 Agent 队列模式: ${mode}`);
  if (!redisUrl) throw new Error('AGENT_QUEUE_MODE=bullmq 需要 REDIS_URL');

  // 延迟加载，AGENT_QUEUE_MODE=off 时不需要 Redis 依赖参与启动
  const IORedis = require('ioredis');
  const { Queue } = require('bullmq');
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[agent-queue] redis error:', error.message);
  });
  const queue = new Queue(name, { connection, prefix });

  return {
    mode,
    async enqueue(taskId) {
      let timer = null;
      try {
        await Promise.race([
          queue.add(
            'run',
            { taskId },
            {
              jobId: taskId,
              // 脚本失败不得自动重跑；模型网络重试由后续阶段的模型客户端单独控制
              attempts: 1,
              removeOnComplete: { age: 3600, count: 100 },
              removeOnFail: { age: 86400, count: 100 },
            }
          ),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('agent queue enqueue timeout')),
              enqueueTimeoutMs
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close() {
      await queue.close().catch(() => {});
      if (connection.status !== 'end') await connection.quit().catch(() => {});
    },
  };
}

function createAgentWorker({ redisUrl, name, prefix, concurrency = 1, handler }) {
  if (!redisUrl) throw new Error('Agent Worker 需要 REDIS_URL');
  if (typeof handler !== 'function') throw new Error('Agent Worker 需要 handler');

  const IORedis = require('ioredis');
  const { Worker } = require('bullmq');
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[agent-worker] redis error:', error.message);
  });
  const worker = new Worker(
    name,
    async (job) => handler(job.data.taskId),
    { connection, prefix, concurrency }
  );

  worker.on('failed', (job, error) => {
    // eslint-disable-next-line no-console
    console.error('[agent-worker] job failed:', job?.id, error?.message);
  });
  worker.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[agent-worker] error:', error.message);
  });

  return {
    worker,
    async close() {
      await worker.close().catch(() => {});
      if (connection.status !== 'end') await connection.quit().catch(() => {});
    },
  };
}

module.exports = { createAgentQueue, createAgentWorker };
