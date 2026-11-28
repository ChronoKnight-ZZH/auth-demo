'use strict';
/**
 * Agent Harness 阶段 1 测试：状态机、参数校验、仓储隔离、服务编排、路由。
 * 运行：node --test test/agent.test.js
 *
 * 全部使用内存实现，不依赖 MySQL / Redis / Docker；模型与脚本执行器尚未接入。
 */
process.env.PEPPER = process.env.PEPPER || 'test-pepper-0123456789abcdef';
process.env.AGENT_ENABLED = '1';
process.env.AGENT_QUEUE_MODE = 'off';
process.env.AGENT_EXECUTION_ENABLED = '0';
process.env.MYSQL_URL = '';
process.env.REDIS_URL = '';
process.env.FILES_MODE = 'local';

require('../src/lib/fetch-global');

const nodeTest = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { config } = require('../src/config');
const { AppError, errorHandler } = require('../src/lib/errors');
const { MemoryFileRepo } = require('../src/db/memory-file-repo');
const { MemoryChatRepo } = require('../src/db/memory-chat-repo');
const { MemoryAgentTaskRepository } = require('../src/modules/agent/repositories/memory-agent-task.repository');
const {
  TASK_STATUS,
  STEP_TYPE,
  FILE_ROLE,
  isTerminalStatus,
} = require('../src/modules/agent/types/agent.types');
const {
  canTransition,
  assertTransition,
  claimPatch,
} = require('../src/modules/agent/core/task-state-machine');
const {
  parseCreateTask,
  parseTaskId,
} = require('../src/modules/agent/api/agent.validator');
const { createAgentFeatureGate } = require('../src/modules/agent/api/agent.feature-gate');
const { createCreateTaskService } = require('../src/modules/agent/application/create-task.service');
const { createGetTaskService } = require('../src/modules/agent/application/get-task.service');
const { createCancelTaskService } = require('../src/modules/agent/application/cancel-task.service');
const { createAgentController } = require('../src/modules/agent/api/agent.controller');
const { createAgentRoutes } = require('../src/modules/agent/api/agent.routes');
const { ToolRegistry } = require('../src/modules/agent/core/tool-registry');
const { executeTool } = require('../src/modules/agent/core/tool-executor');
const { validateToolInput } = require('../src/modules/agent/core/tool-schema');
const {
  WorkspaceManager,
  safeFileName,
  assertInside,
} = require('../src/modules/agent/executor/workspace-manager');
const { createDefaultToolRegistry } = require('../src/modules/agent/tools/default-tools');
const { runAgentTask } = require('../src/modules/agent/core/agent-loop');

/** Node 16 兼容的 t.after 清理（与 stream.test.js 同款） */
function test(name, fn) {
  return nodeTest(name, async (t) => {
    if (typeof t.after === 'function') return fn(t);
    const hooks = [];
    t.after = (hook) => { hooks.push(hook); };
    try {
      return await fn(t);
    } finally {
      for (const hook of hooks.reverse()) {
        try { await hook(); } catch { /* 清理失败不影响断言 */ }
      }
    }
  });
}

function makeTask(overrides = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    userId: 1,
    conversationId: null,
    status: TASK_STATUS.QUEUED,
    inputText: '统计附件里的销售数据',
    currentStep: null,
    resultText: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    modelCalls: 0,
    toolCalls: 0,
    deadlineAt: now + 600_000,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeFile(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    sha256: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    storageKey: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    size: 1024,
    mime: 'text/csv',
    name: 'sales.csv',
    isImage: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------- 状态机

test('状态机：合法迁移与终态不可回退', () => {
  assert.strictEqual(canTransition(TASK_STATUS.QUEUED, TASK_STATUS.RUNNING), true);
  assert.strictEqual(canTransition(TASK_STATUS.RUNNING, TASK_STATUS.WAITING_MODEL), true);
  assert.strictEqual(canTransition(TASK_STATUS.WAITING_MODEL, TASK_STATUS.COMPLETED), true);
  assert.strictEqual(canTransition(TASK_STATUS.COMPLETED, TASK_STATUS.RUNNING), false);
  assert.strictEqual(canTransition(TASK_STATUS.CANCELLED, TASK_STATUS.RUNNING), false);
  assert.strictEqual(isTerminalStatus(TASK_STATUS.TIMED_OUT), true);
});

test('状态机：非法迁移抛 AGENT_INVALID_STATE', () => {
  assert.throws(
    () => assertTransition(TASK_STATUS.COMPLETED, TASK_STATUS.RUNNING),
    (error) => error instanceof AppError && error.code === 'AGENT_INVALID_STATE'
  );
});

test('状态机：领取补丁只把 queued 推进到 running', () => {
  const patch = claimPatch(123);
  assert.strictEqual(patch.status, TASK_STATUS.RUNNING);
  assert.strictEqual(patch.startedAt, 123);
  assert.strictEqual(patch.updatedAt, 123);
});

// ---------------------------------------------------------------- 参数校验

test('校验：创建任务接受最小字段并生成默认值', () => {
  const input = parseCreateTask({ message: '  你好  ' });
  assert.deepStrictEqual(input, {
    message: '你好',
    conversationId: null,
    fileIds: [],
    idempotencyKey: null,
  });
});

test('校验：拒绝空消息、非法会话 ID、非法文件 ID 与超长消息', () => {
  const invalid = (body) => assert.throws(
    () => parseCreateTask(body),
    (error) => error instanceof AppError && error.code === 'INVALID_INPUT'
  );

  invalid({});
  invalid({ message: '   ' });
  invalid({ message: 'hi', conversation_id: 'short' });
  invalid({ message: 'hi', file_ids: ['not a valid id'] });
  invalid({ message: 'hi', file_ids: 'abc' });

  assert.throws(
    () => parseCreateTask({ message: 'x'.repeat(13 * 1024) }),
    (error) => error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE'
  );
});

test('校验：file_ids 去重且保留顺序，幂等键来自请求头', () => {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const input = parseCreateTask(
    { message: 'hi', file_ids: [a, b, a] },
    { 'idempotency-key': ' req-key-12345678 ' }
  );
  assert.deepStrictEqual(input.fileIds, [a, b]);
  assert.strictEqual(input.idempotencyKey, 'req-key-12345678');
});

test('校验：任务 ID 只接受固定字符集与长度', () => {
  const id = crypto.randomUUID();
  assert.strictEqual(parseTaskId(id), id);
  assert.throws(
    () => parseTaskId('../etc/passwd'),
    (error) => error instanceof AppError && error.code === 'INVALID_INPUT'
  );
});

// ---------------------------------------------------------------- 仓储隔离

test('内存仓储：按 userId 隔离，跨用户查询返回 null', async () => {
  const repo = new MemoryAgentTaskRepository();
  const task = makeTask();
  await repo.createTask(task, []);

  assert.strictEqual((await repo.getTask(1, task.id)).id, task.id);
  assert.strictEqual(await repo.getTask(2, task.id), null);
  assert.strictEqual(await repo.getTaskById(task.id) === null, false);
  await repo.close();
});

test('内存仓储：同一用户的幂等键冲突，不同用户互不影响', async () => {
  const repo = new MemoryAgentTaskRepository();
  const key = 'idem-key-12345678';
  await repo.createTask(makeTask({ idempotencyKey: key }), []);

  await assert.rejects(
    repo.createTask(makeTask({ idempotencyKey: key }), []),
    (error) => error.code === 'ER_DUP_ENTRY'
  );
  await repo.createTask(makeTask({ userId: 2, idempotencyKey: key }), []);
  assert.strictEqual((await repo.findByIdempotencyKey(1, key)).userId, 1);
  assert.strictEqual((await repo.findByIdempotencyKey(2, key)).userId, 2);
  await repo.close();
});

test('内存仓储：条件迁移不满足时返回 null，不覆盖终态', async () => {
  const repo = new MemoryAgentTaskRepository();
  const task = makeTask({ status: TASK_STATUS.COMPLETED });
  await repo.createTask(task, []);

  const updated = await repo.transitionTask(task.id, [TASK_STATUS.QUEUED], {
    status: TASK_STATUS.RUNNING,
  });
  assert.strictEqual(updated, null);
  assert.strictEqual((await repo.getTaskById(task.id)).status, TASK_STATUS.COMPLETED);
  await repo.close();
});

// ---------------------------------------------------------------- 创建 / 查询 / 取消

async function makeServices({ userId = 1, file = null } = {}) {
  const taskRepo = new MemoryAgentTaskRepository();
  const fileRepo = new MemoryFileRepo();
  let stored = null;
  if (file) stored = await fileRepo.create(userId, file);

  const createTask = createCreateTaskService({ taskRepo, fileRepo, chatRepo: new MemoryChatRepo() });
  const getTaskService = createGetTaskService({ taskRepo });
  const cancelTask = createCancelTaskService({ taskRepo });
  return { taskRepo, fileRepo, stored, createTask, getTaskService, cancelTask };
}

test('创建任务：落库为 queued，并保存输入文件授权快照', async () => {
  const file = makeFile();
  const { taskRepo, stored, createTask } = await makeServices({ file });

  const task = await createTask(1, {
    message: '分析这份 CSV',
    conversationId: null,
    fileIds: [stored.id],
    idempotencyKey: null,
  });

  assert.strictEqual(task.status, TASK_STATUS.QUEUED);
  assert.strictEqual(task.userId, 1);
  assert.ok(task.deadlineAt > task.createdAt);

  const files = await taskRepo.listFiles(task.id);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].fileRole, FILE_ROLE.INPUT);
  assert.strictEqual(files[0].fileId, stored.id);
  assert.strictEqual(files[0].fileName, 'sales.csv');
});

test('创建任务：幂等键重复提交返回同一任务', async () => {
  const { createTask } = await makeServices();
  const input = {
    message: '你好',
    conversationId: null,
    fileIds: [],
    idempotencyKey: 'same-key-12345678',
  };
  const first = await createTask(1, input);
  const second = await createTask(1, input);
  assert.strictEqual(second.id, first.id);
});

test('创建任务：引用其他用户的文件返回 FILE_ACCESS_DENIED', async () => {
  const file = makeFile();
  const { stored, createTask } = await makeServices({ userId: 1, file });

  await assert.rejects(
    createTask(2, {
      message: '偷看',
      conversationId: null,
      fileIds: [stored.id],
      idempotencyKey: null,
    }),
    (error) => error instanceof AppError && error.code === 'FILE_ACCESS_DENIED'
  );
});

test('查询任务：跨用户统一 AGENT_TASK_NOT_FOUND', async () => {
  const { createTask, getTaskService } = await makeServices();
  const task = await createTask(1, {
    message: '你好',
    conversationId: null,
    fileIds: [],
    idempotencyKey: null,
  });

  await assert.rejects(
    getTaskService.getTask(2, task.id),
    (error) => error instanceof AppError && error.code === 'AGENT_TASK_NOT_FOUND'
  );
});

test('取消任务：queued → cancelled，重复取消返回 cancelled=false', async () => {
  const { createTask, cancelTask, getTaskService } = await makeServices();
  const task = await createTask(1, {
    message: '你好',
    conversationId: null,
    fileIds: [],
    idempotencyKey: null,
  });

  const first = await cancelTask(1, task.id);
  assert.strictEqual(first.cancelled, true);
  assert.strictEqual(first.task.status, TASK_STATUS.CANCELLED);
  assert.ok(first.task.finishedAt);

  const second = await cancelTask(1, task.id);
  assert.strictEqual(second.cancelled, false);

  const { task: current } = await getTaskService.getTask(1, task.id);
  assert.strictEqual(current.status, TASK_STATUS.CANCELLED);
});

// ---------------------------------------------------------------- 工具与工作目录

test('工具 schema：过滤未知字段并拒绝错误类型/枚举', () => {
  const schema = {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python'] },
      script: { type: 'string', minLength: 1 },
      retries: { type: 'integer', minimum: 0, maximum: 3 },
    },
    required: ['language', 'script'],
    additionalProperties: false,
  };

  const ok = validateToolInput(schema, { language: 'python', script: 'print(1)', retries: 2 });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.value, { language: 'python', script: 'print(1)', retries: 2 });

  assert.strictEqual(validateToolInput(schema, { language: 'shell', script: 'x' }).ok, false);
  assert.strictEqual(validateToolInput(schema, { language: 'python' }).ok, false);
  assert.strictEqual(
    validateToolInput(schema, { language: 'python', script: 'x', extra: 1 }).ok,
    false
  );
  assert.strictEqual(
    validateToolInput(schema, { language: 'python', script: 'x', retries: 4 }).ok,
    false
  );
});

test('工具注册表：模型视图不包含 handler，未知工具拒绝', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: '回显参数',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async ({ text }) => ({ text }),
  });

  const forModel = registry.listForModel();
  assert.deepStrictEqual(Object.keys(forModel[0]).sort(), ['description', 'input_schema', 'name']);
  assert.strictEqual(forModel[0].handler, undefined);

  const result = await executeTool({ registry, name: 'echo', input: { text: 'hi' } });
  assert.deepStrictEqual(result, { text: 'hi' });

  await assert.rejects(
    executeTool({ registry, name: 'echo', input: { text: 'hi', ignored: true } }),
    (error) => error instanceof AppError && error.code === 'AGENT_TOOL_INVALID_INPUT'
  );

  await assert.rejects(
    executeTool({ registry, name: 'rm_rf', input: {} }),
    (error) => error instanceof AppError && error.code === 'AGENT_TOOL_NOT_FOUND'
  );
});

test('工具执行器：超时返回 AGENT_TOOL_TIMEOUT', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'slow',
    description: '慢工具',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 5,
    handler: () => new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
  });

  await assert.rejects(
    executeTool({ registry, name: 'slow', input: {} }),
    (error) => error instanceof AppError && error.code === 'AGENT_TOOL_TIMEOUT'
  );
});

test('默认工具：阶段 1 未注入 handler 时统一返回执行器未就绪', async () => {
  const registry = createDefaultToolRegistry();
  await assert.rejects(
    executeTool({ registry, name: 'run_script', input: { language: 'python', script: 'print(1)' } }),
    (error) => error instanceof AppError && error.code === 'AGENT_EXECUTOR_UNAVAILABLE'
  );
});

test('工作目录：文件名剥离路径，拼接后不得越界', async () => {
  assert.strictEqual(safeFileName('../../etc/passwd'), 'passwd');
  assert.strictEqual(safeFileName('C:\\Windows\\system.ini'), 'system.ini');
  assert.strictEqual(safeFileName('..'), 'file');
  assert.strictEqual(safeFileName('   '), 'file');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-ws-'));
  const manager = new WorkspaceManager({ rootDir: root, taskId: crypto.randomUUID() });
  try {
    const paths = await manager.init();
    assert.strictEqual(paths.output.startsWith(paths.root), true);
    // safeFileName 先剥离 ..，结果仍落在 output 目录内
    const escaped = manager.resolveOutput('../escape.txt');
    assert.strictEqual(path.dirname(escaped), paths.output);
    assert.strictEqual(path.basename(escaped), 'escape.txt');
    // 直接验证最后一道 assertInside 边界
    assert.throws(
      () => assertInside(paths.output, path.join(paths.root, 'escape.txt')),
      (error) => error instanceof AppError && error.code === 'INVALID_INPUT'
    );
  } finally {
    await manager.cleanup();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Worker 占位

test('Agent Loop：执行器关闭时拒绝领取任务', async () => {
  const repo = new MemoryAgentTaskRepository();
  await assert.rejects(
    runAgentTask(crypto.randomUUID(), { taskRepo: repo }),
    (error) => error instanceof AppError && error.code === 'AGENT_EXECUTOR_UNAVAILABLE'
  );
  await repo.close();
});

// ---------------------------------------------------------------- 超时兜底

const {
  staleReason,
  settleTask,
  staleWhere,
  NO_CONSUMER_GRACE_MS,
} = require('../src/modules/agent/core/task-watchdog');

async function seedTask(repo, over = {}) {
  const createdAt = over.createdAt ?? Date.now();
  const task = {
    id: crypto.randomUUID(),
    userId: 1,
    conversationId: null,
    status: TASK_STATUS.QUEUED,
    inputText: '兜底测试',
    currentStep: null,
    resultText: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    modelCalls: 0,
    toolCalls: 0,
    deadlineAt: createdAt + 600_000,
    startedAt: null,
    finishedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
  await repo.createTask(task, []);
  return task;
}

test('状态机：queued 允许直接到期转 timed_out（没人领取也要能收场）', () => {
  assert.strictEqual(canTransition(TASK_STATUS.QUEUED, TASK_STATUS.TIMED_OUT), true);
  assertTransition(TASK_STATUS.QUEUED, TASK_STATUS.TIMED_OUT);
});

test('watchdog：没有任何消费方时，queued 过宽限期判 AGENT_NO_CONSUMER', () => {
  const now = 1_800_000_000_000;
  const reason = staleReason(
    { status: TASK_STATUS.QUEUED, createdAt: now - NO_CONSUMER_GRACE_MS - 1, deadlineAt: now + 600_000 },
    { now, queueTimeoutMs: 60_000, hasConsumer: false }
  );
  assert.strictEqual(reason.code, 'AGENT_NO_CONSUMER');
  // 宽限期内不动：给 inline / Worker 一点领取时间
  assert.strictEqual(
    staleReason(
      { status: TASK_STATUS.QUEUED, createdAt: now - 1_000, deadlineAt: now + 600_000 },
      { now, queueTimeoutMs: 60_000, hasConsumer: false }
    ),
    null
  );
});

test('watchdog：有生产者但 Worker 掉了 → 排队上限后 AGENT_QUEUE_TIMEOUT', () => {
  const now = 1_800_000_000_000;
  const reason = staleReason(
    { status: TASK_STATUS.QUEUED, createdAt: now - 61_000, deadlineAt: now + 539_000 },
    { now, queueTimeoutMs: 60_000, hasConsumer: true }
  );
  assert.strictEqual(reason.code, 'AGENT_QUEUE_TIMEOUT');
});

test('watchdog：running / waiting_model 只看 deadline_at', () => {
  const now = 1_800_000_000_000;
  for (const status of [TASK_STATUS.RUNNING, TASK_STATUS.WAITING_MODEL]) {
    const expired = staleReason(
      { status, createdAt: now - 59_000, deadlineAt: now - 1 },
      { now, queueTimeoutMs: 60_000, hasConsumer: true }
    );
    assert.strictEqual(expired.code, 'AGENT_TASK_TIMEOUT', status);
    const alive = staleReason(
      { status, createdAt: now - 59_000, deadlineAt: now + 1 },
      { now, queueTimeoutMs: 60_000, hasConsumer: true }
    );
    assert.strictEqual(alive, null, status);
  }
});

test('watchdog：终态任务原样返回，不被兜底覆盖', () => {
  const now = 1_800_000_000_000;
  for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]) {
    assert.strictEqual(
      staleReason(
        { status, createdAt: now - 9_999_999, deadlineAt: now - 1 },
        { now, queueTimeoutMs: 60_000, hasConsumer: false }
      ),
      null, status
    );
  }
});

test('watchdog：settleTask 条件迁移，settle 后已是终态', async () => {
  const repo = new MemoryAgentTaskRepository();
  const now = Date.now();
  const stale = await seedTask(repo, { createdAt: now - 120_000, deadlineAt: now - 1 });
  const settled = await settleTask(repo, stale, { now, queueTimeoutMs: 60_000, hasConsumer: true });
  assert.strictEqual(settled.status, TASK_STATUS.TIMED_OUT);
  assert.strictEqual(settled.errorCode, 'AGENT_TASK_TIMEOUT');
  assert.strictEqual((await repo.getTaskById(stale.id)).status, TASK_STATUS.TIMED_OUT);

  // 再 settle 一次：终态原样返回
  const again = await settleTask(repo, settled, { now: now + 1000, queueTimeoutMs: 60_000, hasConsumer: true });
  assert.strictEqual(again.status, TASK_STATUS.TIMED_OUT);
  await repo.close();
});

test('watchdog：findStale 只捞过期的活动任务', async () => {
  const repo = new MemoryAgentTaskRepository();
  const now = Date.now();
  const fresh = await seedTask(repo, { createdAt: now - 1_000 });
  const stuckQueued = await seedTask(repo, { createdAt: now - 120_000 });
  const overdueRun = await seedTask(repo, {
    status: TASK_STATUS.RUNNING, createdAt: now - 120_000, deadlineAt: now - 1, startedAt: now - 120_000,
  });
  const done = await seedTask(repo, { status: TASK_STATUS.COMPLETED, createdAt: now - 120_000, deadlineAt: now - 1 });

  const ids = await repo.findStale(staleWhere({ now, queueTimeoutMs: 60_000, hasConsumer: true }));
  assert.ok(ids.includes(stuckQueued.id), '排队超时应命中');
  assert.ok(ids.includes(overdueRun.id), 'running 超总时限应命中');
  assert.ok(!ids.includes(fresh.id), '刚提交的不该命中');
  assert.ok(!ids.includes(done.id), '终态不该命中');
  await repo.close();
});

test('读时兜底：getTask 即收敛，前端不会无限轮询', async () => {
  const repo = new MemoryAgentTaskRepository();
  const now = Date.now();
  const task = await seedTask(repo, { createdAt: now - 120_000 });
  const getTaskService = createGetTaskService({ taskRepo: repo, queueTimeoutMs: 60_000, hasConsumer: true });
  const { task: read } = await getTaskService.getTask(1, task.id);
  assert.strictEqual(read.status, TASK_STATUS.TIMED_OUT);
  assert.strictEqual(read.errorCode, 'AGENT_QUEUE_TIMEOUT');
  assert.ok(isTerminalStatus(read.status), '读一次就应为终态');
  await repo.close();
});

// ---------------------------------------------------------------- HTTP 路由

async function buildAgentApp({ enabled = true, allowlist = [] } = {}) {
  const taskRepo = new MemoryAgentTaskRepository();
  const fileRepo = new MemoryFileRepo();
  const featureGate = createAgentFeatureGate({ enabled, allowlist });
  const createTask = createCreateTaskService({ taskRepo, fileRepo, chatRepo: new MemoryChatRepo() });
  const getTaskService = createGetTaskService({ taskRepo });
  const cancelTask = createCancelTaskService({ taskRepo });
  const controller = createAgentController({
    createTask,
    getTaskService,
    cancelTask,
    featureGate,
  });
  // 测试替身：从 x-test-user 取用户 ID，替代真实 Cookie/Bearer 鉴权
  const authenticate = (req, res, next) => {
    const raw = req.get('x-test-user');
    if (!raw) return res.status(401).json({ code: 'TOKEN_MISSING' });
    req.userId = Number(raw);
    return next();
  };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/agent', createAgentRoutes({ controller, authenticate, featureGate }));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    taskRepo,
    fileRepo,
    server,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await taskRepo.close();
    },
  };
}

async function call(base, pathname, { method = 'GET', userId = 1, body, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      connection: 'close',
      ...(userId == null ? {} : { 'x-test-user': String(userId) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
  };
}

test('HTTP：创建、查询、取消任务全链路', async () => {
  const ctx = await buildAgentApp();
  try {
    const created = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      body: { message: '做一个销售汇总' },
    });
    assert.strictEqual(created.status, 202);
    assert.strictEqual(created.json.status, TASK_STATUS.QUEUED);
    const taskId = created.json.task_id;
    assert.match(taskId, /^[A-Za-z0-9_-]{8,64}$/);

    const fetched = await call(ctx.base, `/api/agent/tasks/${taskId}`);
    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.json.task_id, taskId);
    assert.deepStrictEqual(fetched.json.files, []);
    assert.strictEqual(fetched.json.status_url, `/api/agent/tasks/${taskId}`);

    const steps = await call(ctx.base, `/api/agent/tasks/${taskId}/steps`);
    assert.strictEqual(steps.status, 200);
    assert.deepStrictEqual(steps.json.steps, []);

    const cancelled = await call(ctx.base, `/api/agent/tasks/${taskId}/cancel`, { method: 'POST' });
    assert.strictEqual(cancelled.status, 200);
    assert.strictEqual(cancelled.json.cancelled, true);
    assert.strictEqual(cancelled.json.task.status, TASK_STATUS.CANCELLED);

    const again = await call(ctx.base, `/api/agent/tasks/${taskId}/cancel`, { method: 'POST' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.cancelled, false);
  } finally {
    await ctx.close();
  }
});

test('HTTP：轮询到过期任务时直接给出终态（不再一直 queued）', async () => {
  const ctx = await buildAgentApp();
  try {
    const created = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      body: { message: '提交给一个没人在跑的队列' },
    });
    assert.strictEqual(created.status, 202);
    const taskId = created.json.task_id;

    // 把创建时间推到排队上限之前，模拟「Worker 没跑」
    const now = Date.now();
    await ctx.taskRepo.updateTask(taskId, { status: TASK_STATUS.QUEUED, createdAt: now - 3_600_000 });

    const fetched = await call(ctx.base, `/api/agent/tasks/${taskId}`);
    assert.strictEqual(fetched.json.status, TASK_STATUS.TIMED_OUT, JSON.stringify(fetched.json.error));
    assert.strictEqual(fetched.json.error.code, 'AGENT_QUEUE_TIMEOUT');
    // 再读一次仍是终态，不会回退
    const again = await call(ctx.base, `/api/agent/tasks/${taskId}`);
    assert.strictEqual(again.json.status, TASK_STATUS.TIMED_OUT);
  } finally {
    await ctx.close();
  }
});

test('HTTP：跨用户访问 404，白名单外 403，未登录 401', async () => {
  const ctx = await buildAgentApp({ allowlist: ['1', '2'] });
  try {
    const created = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      userId: 1,
      body: { message: '你好' },
    });
    const taskId = created.json.task_id;

    const other = await call(ctx.base, `/api/agent/tasks/${taskId}`, { userId: 2 });
    assert.strictEqual(other.status, 404);
    assert.strictEqual(other.json.code, 'AGENT_TASK_NOT_FOUND');

    const outsider = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      userId: 3,
      body: { message: '你好' },
    });
    assert.strictEqual(outsider.status, 403);
    assert.strictEqual(outsider.json.code, 'AGENT_NOT_ALLOWED');

    const anonymous = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      userId: null,
      body: { message: '你好' },
    });
    assert.strictEqual(anonymous.status, 401);
  } finally {
    await ctx.close();
  }
});

test('HTTP：幂等键重复提交返回同一任务；他人文件引用返回 404', async () => {
  const ctx = await buildAgentApp();
  try {
    const headers = { 'idempotency-key': 'http-key-12345678' };
    const first = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      headers,
      body: { message: '生成报告' },
    });
    const second = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      headers,
      body: { message: '生成报告' },
    });
    assert.strictEqual(first.status, 202);
    assert.strictEqual(second.status, 202);
    assert.strictEqual(second.json.task_id, first.json.task_id);

    const otherFile = await ctx.fileRepo.create(2, makeFile({ name: 'secret.csv' }));
    const denied = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      userId: 1,
      body: { message: '读取', file_ids: [otherFile.id] },
    });
    assert.strictEqual(denied.status, 404);
    assert.strictEqual(denied.json.code, 'FILE_ACCESS_DENIED');
  } finally {
    await ctx.close();
  }
});

test('HTTP：总开关关闭时返回 503 AGENT_DISABLED', async () => {
  const ctx = await buildAgentApp({ enabled: false });
  try {
    const response = await call(ctx.base, '/api/agent/tasks', {
      method: 'POST',
      body: { message: '你好' },
    });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.json.code, 'AGENT_DISABLED');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 配置基线

test('配置：阶段 1 默认关闭执行器与队列，限制值符合方案', () => {
  assert.strictEqual(config.agent.enabled, true, '测试进程显式开启 Agent');
  assert.strictEqual(config.agent.executionEnabled, false);
  assert.strictEqual(config.agent.queueMode, 'off');
  assert.strictEqual(config.agent.taskTimeoutMs, 600_000);
  assert.strictEqual(config.agent.scriptTimeoutMs, 120_000);
  assert.strictEqual(config.agent.maxInputBytes, 128 * 1024 * 1024);
  assert.strictEqual(config.agent.maxOutputBytes, 64 * 1024 * 1024);
  assert.strictEqual(config.agent.maxOutputFiles, 10);
  assert.strictEqual(config.agent.userQuotaBytes, 20 * 1024 * 1024 * 1024);
  assert.strictEqual(config.agent.retentionDays, 30);
  assert.strictEqual(config.agent.logRetentionDays, 7);
  assert.strictEqual(config.agent.outputRetentionDays, 30);
});

// 步骤记录的类型常量至少保证与迁移文件一致
test('类型常量：步骤类型为 model/tool', () => {
  assert.deepStrictEqual(Object.values(STEP_TYPE).sort(), ['model', 'tool']);
});
