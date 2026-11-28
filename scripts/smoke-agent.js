'use strict';
/**
 * Agent 开发环境冒烟脚本：登录 → 创建任务 → 轮询状态 → 查看步骤 → 取消任务。
 * 用法：node scripts/smoke-agent.js [baseUrl]
 *
 * 前置：后端需以 Agent 模式启动（内存 + inline 队列为最省事组合）：
 *   ENV_FILE=data/agent-smoke-config node src/server.js
 *
 * 阶段 1 预期行为：inline 队列会立即领取任务（queued→running），
 * 执行器占位逻辑随后把任务落为 failed + AGENT_EXECUTOR_UNAVAILABLE，
 * 这恰好端到端验证了「API → 仓储 → 队列 → Worker 状态机」全链路。
 */
const { createClient } = require('./_client');
const crypto = require('node:crypto');

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`目标：${BASE}\n`);
  const client = createClient(BASE);

  const health = await client.call('GET', '/health');
  check('健康检查 200', health.status === 200, JSON.stringify(health.body && health.body.agent));

  // ---- 登录（RSA-OAEP 长度前缀协议，同 smoke.js）----
  const pk = await client.call('GET', '/auth/public-key');
  if (pk.status !== 200) {
    console.error('无法获取公钥，请先启动后端');
    process.exit(1);
  }
  const encrypt = (plain) =>
    crypto
      .publicEncrypt(
        { key: pk.body.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: pk.body.oaepHash },
        Buffer.from(plain, 'utf8')
      )
      .toString('base64');
  const encodeLogin = (u, p) => {
    const ub = Buffer.from(u, 'utf8');
    return Buffer.concat([Buffer.from(`v1\n${ub.length}\n`, 'utf8'), ub, Buffer.from(p, 'utf8')]).toString('utf8');
  };
  const login = await client.call('POST', '/auth/login', {
    body: { encrypted: encrypt(encodeLogin('alice', 'Alice@Passw0rd')) },
  });
  check('登录成功（Cookie 会话）', login.status === 200, `status=${login.status}`);
  if (login.status !== 200) process.exit(1);

  // ---- 未登录访问 Agent API → 401 ----
  const anon = createClient(BASE);
  const anonRes = await anon.call('POST', '/api/agent/tasks', { body: { message: 'hi' } });
  check('未登录创建任务 401', anonRes.status === 401, `${anonRes.status} ${anonRes.body && anonRes.body.code}`);

  // ---- 非法参数 → 400 INVALID_INPUT ----
  const bad = await client.call('POST', '/api/agent/tasks', { body: { message: '   ' } });
  check('空消息 400 INVALID_INPUT', bad.status === 400 && bad.body.code === 'INVALID_INPUT',
    `${bad.status} ${bad.body && bad.body.code}`);

  // ---- 创建任务 → 202 queued ----
  const idemKey = `smoke-${Date.now()}`;
  const created = await client.call('POST', '/api/agent/tasks', {
    body: { message: '统计附件里的销售数据并生成报告' },
    headers: { 'idempotency-key': idemKey },
  });
  check('创建任务 202 且状态 queued', created.status === 202 && created.body.status === 'queued',
    `${created.status} ${created.body && created.body.status} task=${created.body && created.body.task_id}`);
  const taskId = created.body && created.body.task_id;

  // ---- 幂等：同 key 重复提交返回同一任务 ----
  const replay = await client.call('POST', '/api/agent/tasks', {
    body: { message: '统计附件里的销售数据并生成报告' },
    headers: { 'idempotency-key': idemKey },
  });
  check('幂等键重复提交返回同一任务',
    replay.status === 202 && replay.body.task_id === taskId,
    `${replay.status} ${replay.body && replay.body.task_id === taskId}`);

  // ---- inline 队列：轮询观察状态机走到终态 ----
  let final = null;
  for (let i = 0; i < 20; i += 1) {
    const got = await client.call('GET', `/api/agent/tasks/${taskId}`);
    final = got.body;
    if (final && ['failed', 'completed', 'cancelled', 'timed_out'].includes(final.status)) break;
    await sleep(100);
  }
  check('inline 队列消费：任务到达终态', final && final.status !== 'queued' && final.status !== 'running',
    `status=${final && final.status} error=${final && final.error && final.error.code}`);
  check('阶段 1 占位执行器：failed + AGENT_EXECUTOR_UNAVAILABLE',
    final && final.status === 'failed' && final.error && final.error.code === 'AGENT_EXECUTOR_UNAVAILABLE',
    final && final.error && final.error.code);

  // ---- 步骤与文件子资源 ----
  const steps = await client.call('GET', `/api/agent/tasks/${taskId}/steps`);
  check('GET steps 200', steps.status === 200, JSON.stringify(steps.body));
  const files = await client.call('GET', `/api/agent/tasks/${taskId}/files`);
  check('GET files 200', files.status === 200, JSON.stringify(files.body));

  // ---- 取消链路：再建一个任务（幂等 key 不同），尝试取消 ----
  const t2 = await client.call('POST', '/api/agent/tasks', {
    body: { message: '第二个任务，用于取消链路' },
  });
  const cancel = await client.call('POST', `/api/agent/tasks/${t2.body.task_id}/cancel`, { body: {} });
  check('取消任务 200（inline 已消费则 cancelled=false，语义正确）',
    cancel.status === 200 && typeof cancel.body.cancelled === 'boolean',
    `${cancel.status} cancelled=${cancel.body && cancel.body.cancelled} status=${cancel.body && cancel.body.task && cancel.body.task.status}`);

  // ---- 跨用户隔离：查询不存在的任务 404 ----
  const ghost = await client.call('GET', '/api/agent/tasks/nonexistent-task-id-xxxx');
  check('未知任务 400/404（ID 校验或不存在）', ghost.status === 400 || ghost.status === 404,
    `${ghost.status} ${ghost.body && ghost.body.code}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
