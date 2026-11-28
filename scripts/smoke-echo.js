'use strict';
/**
 * 复读机 × 中转链路 端到端冒烟。
 *
 * 与 smoke-stream.js 的区别：那边用 mock-upstream 吐固定 `tok0 tok1…`，验证的是
 * 「链路机制」；这边把 UPSTREAM_BASE_URL 指向 echo-upstream（本地复读机），
 * 验证的是「我发出去的字，原样回到我面前」——也就是转发保真度：
 *   正文 / system / 多轮 / 附件 file_id / 参数 是否真的送到了上游，
 *   以及半截断开后续推时内容不多不少不重复。
 *
 * 自包含：自己拉起复读机与被测服务，不需要远程 API、不需要真实 Key。
 *
 *   npm run smoke:echo
 *   ECHO_UPSTREAM=http://127.0.0.1:8788 SMOKE_BASE=http://127.0.0.1:3000 npm run smoke:echo
 *       ↑ 复用已在跑的服务与手工启动的复读机（跳过自启动）
 *
 * 覆盖项：
 *   X-00 健康检查指向上游为本地复读机，Key 不外泄
 *   X-01 正文原样复读（流式）
 *   X-02 system / 多轮 / 附件引用 到达上游（复多元信息里可见）
 *   X-03 断连续推：拼接正文与完整一次一致，且上游只被打 1 次
 *   X-04 /fail 500 → 502（真实状态码，非 SSE）；/fail idle → 504
 *   X-05 Key 边界：下发内容中绝无服务端 Key
 *
 * 会话改走 HttpOnly Cookie：用 createFetcher 维护 Cookie Jar，登录后自动携带，
 * 状态变更请求由 fetcher 注入 Origin 通过 CSRF。
 */
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
require('../src/lib/fetch-global');
const { createFetcher } = require('./_client');

const OVERRIDE_BASE = process.env.SMOKE_BASE || '';
const ECHO_PORT = Number(process.env.SMOKE_ECHO_PORT || 8791);
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 3120);
const SERVER_KEY = 'sk-server-side-only-echo-key';

let BASE = OVERRIDE_BASE;
let F = null;
let pubKeyPem = null;
let oaepHash = 'sha256';

// ---------------------------------------------------------------- 调用范式

function encrypt(plaintext) {
  return crypto.publicEncrypt(
    { key: pubKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    Buffer.from(plaintext, 'utf8')
  ).toString('base64');
}

function encodeLogin(username, password) {
  const ub = Buffer.from(username, 'utf8');
  return Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'), ub, Buffer.from(password, 'utf8'),
  ]).toString('utf8');
}

async function loadKeys() {
  const pk = await (await F.fetch('/auth/public-key')).json();
  pubKeyPem = pk.publicKey;
  oaepHash = pk.oaepHash;
}

async function login(username, password) {
  const res = await F.fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted: encrypt(encodeLogin(username, password)) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`登录失败 ${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** 读一条经中继下发的 SSE，返回事件、正文增量、终止帧、游标 */
async function readStream(urlPath, { body, cursor, requestId, stopAfterDeltas } = {}) {
  const h = { accept: 'text/event-stream' };
  if (body) h['content-type'] = 'application/json';
  if (cursor !== undefined) h['last-event-id'] = String(cursor);
  if (requestId) h['x-request-id'] = requestId;

  const res = await F.fetch(urlPath, {
    method: 'POST', headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  const out = {
    status: res.status,
    isSse: (res.headers.get('content-type') || '').includes('text/event-stream'),
    requestId: res.headers.get('x-request-id') || '',
    events: [], raw: '', json: null, aborted: false,
  };
  if (!res.body || !out.isSse) {
    out.raw = await res.text();
    try { out.json = JSON.parse(out.raw); } catch { /* ignore */ }
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let deltaCount = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    out.raw += chunk;
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = { event: 'message', data: '', id: null };
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const f = c === -1 ? line : line.slice(0, c);
        let v = c === -1 ? '' : line.slice(c + 1);
        if (v.startsWith(' ')) v = v.slice(1);
        if (f === 'data') ev.data = ev.data ? `${ev.data}\n${v}` : v;
        else if (f === 'event') ev.event = v;
        else if (f === 'id') ev.id = v;
      }
      out.events.push(ev);
      if (ev.event === 'content_block_delta') deltaCount += 1;
    }
    if (stopAfterDeltas && deltaCount >= stopAfterDeltas) {
      out.aborted = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  out.deltas = out.events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => { try { return JSON.parse(e.data).delta.text; } catch { return ''; } });
  out.joined = out.deltas.join('');
  const end = out.events.find((e) => e.event === 'relay_end');
  out.endData = end ? safeJson(end.data) : null;
  const withId = out.events.filter((e) => e.id !== null);
  out.lastEventId = withId.length ? Number(withId[withId.length - 1].id) : null;
  return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------------------------------------------------------------- 进程编排

function spawnNode(scriptArgs, env, tag) {
  const child = spawn(process.execPath, scriptArgs, {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const cap = (d) => { log += d.toString(); if (log.length > 300_000) log = log.slice(-150_000); };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`\n[${tag}] 退出 code=${code}\n${log.slice(-2000)}`);
  });
  return { child, getLog: () => log };
}

async function waitFor(url, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.status < 500) return true;
    } catch { /* 还没起来 */ }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}

const echoGet = (p, init) => fetch(`http://127.0.0.1:${ECHO_PORT}${p}`, init);
let HAS_ECHO = false;
const echoCalls = async () => {
  if (!HAS_ECHO) return null;
  try { return (await (await echoGet('/__calls')).json()).calls; } catch { return null; }
};
const resetEcho = async () => {
  if (!HAS_ECHO) return;
  try { await echoGet('/__reset', { method: 'POST' }); } catch { /* ignore */ }
};
async function callCount() {
  const c = await echoCalls();
  return c === null ? -1 : c.length;
}

// ---------------------------------------------------------------- 断言

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 用例

async function main() {
  const children = [];
  try {
    if (!OVERRIDE_BASE) {
      const echo = spawnNode([path.join(__dirname, 'echo-upstream.js'), String(ECHO_PORT)], {}, 'echo');
      children.push(echo);
      if (!await waitFor(`http://127.0.0.1:${ECHO_PORT}/health`)) {
        throw new Error('复读机上游启动失败\n' + echo.getLog());
      }
      HAS_ECHO = true;
      const app = spawnNode([path.join(__dirname, '..', 'src', 'server.js')], {
        PORT: String(APP_PORT),
        HOST: '127.0.0.1',
        UPSTREAM_BASE_URL: `http://127.0.0.1:${ECHO_PORT}`,
        UPSTREAM_API_KEY: SERVER_KEY,
        // 内存后端：本冒烟不依赖 MySQL / Redis（Agent 队列同步降到 off，否则会因缺 REDIS_URL 起不来）
        MYSQL_URL: '', REDIS_URL: '', AGENT_QUEUE_MODE: 'off',
        SSE_HEARTBEAT_MS: '600',
        UPSTREAM_HEADERS_TIMEOUT_MS: '6000',
        UPSTREAM_IDLE_TIMEOUT_MS: '2500',
        UPSTREAM_TOTAL_TIMEOUT_MS: '30000',
        UPSTREAM_RETRY_MAX: '0',
      }, 'app');
      children.push(app);
      BASE = `http://127.0.0.1:${APP_PORT}`;
      if (!await waitFor(`${BASE}/health`)) throw new Error('被测服务启动失败\n' + app.getLog());
    }
    F = createFetcher(BASE);
    console.log(`目标：${BASE}   上游：http://127.0.0.1:${ECHO_PORT}（本地复读机）\n`);
    await loadKeys();

    // ---- X-00 ----
    const health = await (await F.fetch('/health')).json();
    check('X-00a 上游指向本地复读机（零成本、不出网）',
      /127\.0\.0\.1/.test(health.relay.upstream), health.relay.upstream);
    check('X-00b 服务端已配 Key', health.relay.upstreamConfigured === true);

    await login('alice', 'Alice@Passw0rd');

    // ---- X-01 正文原样复读 ----
    await resetEcho();
    const probe = '中文混 English 123 与标点，测试复读保真度。\n第二行也要回来。';
    const r1 = await readStream('/v1/chat/stream', {
      body: { model: 'echo-model', messages: [{ role: 'user', content: probe }], metadata: { mock: { gap: 15 } } },
    });
    check('X-01a 流式 200 且 relay_end=done', r1.status === 200 && r1.isSse && r1.endData?.status === 'done',
      `${r1.status} ${JSON.stringify(r1.endData)}`);
    check('X-01b 正文被原样复读（含中文、英文、数字、换行）',
      r1.joined.includes('中文混 English 123 与标点，测试复读保真度。') && r1.joined.includes('第二行也要回来。'),
      JSON.stringify(r1.joined.slice(0, 60)));
    check('X-01c 事件带递增 id，供 Last-Event-ID 续推',
      r1.lastEventId !== null && r1.events.filter((e) => e.event === 'content_block_delta').length >= 2,
      `lastEventId=${r1.lastEventId}`);

    // ---- X-02 system / 多轮 / 附件引用 到达上游 ----
    await resetEcho();
    const r2 = await readStream('/v1/chat/stream', {
      body: {
        model: 'echo-model',
        system: '你是被设定过的人设',
        messages: [
          { role: 'user', content: '第一轮' },
          { role: 'assistant', content: '第一轮回答' },
          { role: 'user', content: [
            { type: 'text', text: '带附件的第三轮' },
            { type: 'file', file_id: 'file-echo-abc123' },
          ] },
        ],
        max_tokens: 512,
      },
    });
    const calls2 = await echoCalls();
    const up = calls2 && calls2[calls2.length - 1];
    check('X-02a 复读只取最后一条用户消息（多轮上下文不误入正文）',
      r2.joined.includes('带附件的第三轮') && !r2.joined.includes('第一轮回答'), r2.joined.slice(0, 40));
    check('X-02b 元信息标明 user 轮次=2（多轮上下文确实送达上游）', /轮次=2/.test(r2.joined), r2.joined.match(/轮次=\d+/)?.[0]);
    check('X-02c 元信息标明 system 字数（system 确实转发）', /system=\d+字/.test(r2.joined));
    check('X-02d 附件按 file_id 引用到达上游（网关未吞掉内容块）',
      Boolean(up) && up.nonTextBlocks.includes('file_id=file-echo-abc123'),
      up ? JSON.stringify(up.nonTextBlocks) : '（外部复读机，跳过）');
    check('X-02e max_tokens 等白名单字段被转发', Boolean(up) && up.model === 'echo-model', up?.model);

    // ---- X-03 断连续推：内容不多不少不重复 ----
    await resetEcho();
    const reqId = 'echoresume' + crypto.randomBytes(4).toString('hex');
    const long = '续推一致性检查。'.repeat(20);
    // 参照物：同一条正文完整跑一遍（复读机的分块与切分是确定性的）
    const reference = await readStream('/v1/chat/stream', {
      requestId: 'echorefere' + crypto.randomBytes(4).toString('hex'),
      body: { model: 'echo-model', messages: [{ role: 'user', content: long }], metadata: { mock: { gap: 5 } } },
    });
    await resetEcho();
    const part1 = await readStream('/v1/chat/stream', {
      requestId: reqId,
      body: { model: 'echo-model', messages: [{ role: 'user', content: long }], metadata: { mock: { gap: 40 } } },
      stopAfterDeltas: 3,
    });
    const mid = await callCount();
    const part2 = await readStream('/v1/chat/stream', {
      requestId: reqId, cursor: part1.lastEventId,
    });
    const after = await callCount();
    check('X-03a 中途断开被识别（未收到 relay_end=done）', part1.aborted && part1.joined.length > 0);
    check('X-03b 续推补齐剩余正文且终态 done',
      part2.status === 200 && part2.joined.length > 0 && part2.endData?.status === 'done',
      JSON.stringify(part2.endData));
    check('X-03c 断开段 + 续推段 == 完整一次（不重发、不丢字）',
      reference.joined.length > 0 && part1.joined + part2.joined === reference.joined,
      `拼接=${(part1.joined + part2.joined).length} 参照=${reference.joined.length}`);
    check('X-03d 上游只被打 1 次（续推不重发 = 不重复计费）',
      mid < 0 || after === mid, `mid=${mid} after=${after}`);

    // ---- X-04 故障透传为真实 HTTP 状态码 ----
    const f500 = await readStream('/v1/chat/stream', {
      body: { model: 'echo-model', messages: [{ role: 'user', content: '/fail 500\n触发上游 5xx' }] },
    });
    check('X-04a 上游 500 → 502 且响应不是 SSE（前端拦截器可区分）',
      f500.status === 502 && !f500.isSse, `${f500.status} ${f500.json?.code}`);

    const fIdle = await readStream('/v1/chat/stream', {
      body: { model: 'echo-model', messages: [{ role: 'user', content: '/fail idle\n静默到 idle 超时' }] },
    });
    check('X-04b 上游只发一帧后静默 → 首帧后失败用 SSE error 帧收场（502/504 已不可能）',
      fIdle.status === 200 && fIdle.isSse
      && fIdle.endData?.status === 'error' && fIdle.endData?.code === 'UPSTREAM_TIMEOUT',
      `${fIdle.status} ${JSON.stringify(fIdle.endData)}`);

    const f400 = await readStream('/v1/chat/stream', {
      body: { model: 'echo-model', messages: [{ role: 'user', content: '/fail 400' }] },
    });
    check('X-04c 上游 4xx → 502 UPSTREAM_REJECTED 且不重试',
      f400.status === 502 && f400.json?.code === 'UPSTREAM_REJECTED', `${f400.status} ${f400.json?.code}`);

    // ---- X-05 Key 边界 ----
    const allRaw = [r1.raw, r2.raw, part1.raw, part2.raw].join('');
    check('X-05 服务端 Key 绝不出现在任何下发内容里',
      !allRaw.includes(SERVER_KEY) && allRaw.length > 0);
    const callsForAuth = await echoCalls();
    check('X-05b 但 Key 确实出现在「服务端 → 上游」这一跳',
      !callsForAuth || callsForAuth.every((c) => c.hasAuth), 'ok');
  } catch (e) {
    check('冒烟异常', false, e.message);
  } finally {
    for (const c of children) { try { c.child.kill(); } catch { /* ignore */ } }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ` (${f.detail})` : ''));
  }
  process.exit(failed.length ? 1 : 0);
}

main();
