'use strict';
/**
 * 中转链路端到端冒烟（时序图 ①②③ 全走真 HTTP）。
 *
 * 自包含：本脚本自己拉起 mock 上游与被测服务，无需手工启动、不依赖真实 DeepSeek Key，
 * 因此 CI / 本机都能一条命令跑通全链路（含断点续推与熔断）。
 *
 *   npm run smoke:stream
 *   SMOKE_BASE=http://127.0.0.1:3000 node scripts/smoke-stream.js   # 复用已在跑的服务（跳过自启动）
 *
 * 覆盖项：
 *   S-00 健康检查暴露 stream 后端与「上游是否已配 Key」
 *   S-01 登录签发 token → /v1/chat/stream 以 Bearer 流式返回
 *   S-02 先鉴权后推流：无/坏 token → 401 JSON（响应绝不伪装成 SSE）
 *   S-03 事件带递增 id；响应头 X-Request-Id 供前端续推
 *   S-05 长流期间写心跳注释行，维持代理空闲与会话 TTL
 *   S-04 断联重发（A 类）：已收内容不重复，续推补齐，拼接等于全文，上游只被打 1 次
 *   S-06 游标语义：非法游标 400、未知 requestId 410、超前游标幂等收尾
 *   S-07 撤销（C 类）：改密后旧 token 的流式请求 401；重登后重发成功（B 类）
 *   S-08 缓存：相同请求第二次不再打上游，回放正文一致
 *   S-09 熔断：连续 5xx 后 503，且不再穿透到上游
 *   S-10 Key 边界：上游 Key 绝不出现在任何下发内容中，但确实只出现在服务端→上游
 */
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const OVERRIDE_BASE = process.env.SMOKE_BASE || '';
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 8787);
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 3110);

/** 服务端专用 Key：冒烟用它断言「Key 不出网关」，脚本自身从不调用上游 */
const SERVER_KEY = 'sk-server-side-only-secret';

let BASE = OVERRIDE_BASE;
let pubKeyPem = null;
let oaepHash = 'sha256';

// ---------------------------------------------------------------- 加密与调用

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

function encodeChange(username, oldPassword, newPassword) {
  const ub = Buffer.from(username, 'utf8');
  const ob = Buffer.from(oldPassword, 'utf8');
  return Buffer.concat([
    Buffer.from(`v2\n${ub.length}\n`, 'utf8'), ub,
    Buffer.from(`${ob.length}\n`, 'utf8'), ob,
    Buffer.from(newPassword, 'utf8'),
  ]).toString('utf8');
}

async function loadKeys(base = BASE) {
  const pk = await (await fetch(base + '/auth/public-key')).json();
  pubKeyPem = pk.publicKey;
  oaepHash = pk.oaepHash;
}

async function login(username, password, base = BASE) {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted: encrypt(encodeLogin(username, password)) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`登录失败 ${res.status} ${JSON.stringify(body)}`);
  return body.token;
}

/**
 * 改密类用例需要「当前可用密码」：同一账号可能被 scripts/smoke.js 或上一次冒烟改过密码，
 * 因此按候选列表试探出当前密码，并改成下一个未被占用的密码，
 * 使脚本在内存与 MySQL 后端上都能重复执行（幂等）。
 */
const BOB_PASSWORDS = ['Bob@Passw0rd', 'Bob@NewPassw0rd', 'Bob@StreamPw2', 'Bob@StreamPw3'];

async function resolvePasswordPair(username, base = BASE) {
  let index = -1;
  for (let i = 0; i < BOB_PASSWORDS.length; i++) {
    try {
      await login(username, BOB_PASSWORDS[i], base);
      index = i;
      break;
    } catch { /* 试下一个 */ }
  }
  if (index < 0) throw new Error(`账号 ${username} 的密码不在候选列表内，请检查库中状态`);
  return { current: BOB_PASSWORDS[index], next: BOB_PASSWORDS[(index + 1) % BOB_PASSWORDS.length] };
}

async function jsonCall(method, urlPath, { body, token, base = BASE } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(base + urlPath, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers.entries()) };
}

/**
 * 读一条 SSE。
 * @param {object} o
 *   token        Bearer
 *   body         请求体（续推时可省）
 *   cursor       Last-Event-ID（带则走续推分支）
 *   requestId    X-Request-Id
 *   stopAfterDeltas 收到 N 个正文增量后主动断开（模拟网络断连）
 * @returns 状态码/头/事件数组/正文增量拼接/终止帧/原始文本/是否主动断开
 */
async function readStream(urlPath, { token, body, cursor, requestId, stopAfterDeltas, base = BASE } = {}) {
  const h = { accept: 'text/event-stream' };
  if (body) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (cursor !== undefined) h['last-event-id'] = String(cursor);
  if (requestId) h['x-request-id'] = requestId;

  const started = Date.now();
  const res = await fetch(base + urlPath, {
    method: 'POST', headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  const out = {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    requestId: res.headers.get('x-request-id') || '',
    accelBuffering: res.headers.get('x-accel-buffering') || '',
    headers: Object.fromEntries(res.headers.entries()),
    isSse: (res.headers.get('content-type') || '').includes('text/event-stream'),
    events: [], raw: '', json: null, aborted: false, ms: 0,
  };

  if (!res.body || !out.isSse) {
    out.raw = await res.text();
    try { out.json = JSON.parse(out.raw); } catch { /* ignore */ }
    out.ms = Date.now() - started;
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
  out.ms = Date.now() - started;

  out.deltas = out.events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => { try { return JSON.parse(e.data).delta.text; } catch { return ''; } });
  out.joined = out.deltas.join('');
  const end = out.events.find((e) => e.event === 'relay_end');
  out.endData = end ? safeJson(end.data) : null;
  // 游标只取「内容事件」的 id：relay_meta 无 id，不会污染 lastEventId
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

const mockGet = (p, init) => fetch(`http://127.0.0.1:${MOCK_PORT}${p}`, init);
/** 是否由本脚本自己拉起 mock：只有自己的 mock 才带 /__calls 计数，可断言「上游只被打 N 次」 */
let HAS_MOCK = false;
const mockCalls = async () => {
  if (!HAS_MOCK) return null;
  try { return (await (await mockGet('/__calls')).json()).calls; } catch { return null; }
};
const resetMock = async () => {
  if (!HAS_MOCK) return;
  try { await mockGet('/__reset', { method: 'POST' }); } catch { /* ignore */ }
};
/** 上游调用次数：非自有 mock 返回 -1，调用方据此跳过该类断言 */
async function callCount() {
  const c = await mockCalls();
  return c === null ? -1 : c.length;
}

async function startRelayApp(name, port, extraEnv) {
  const app = spawnNode([path.join(__dirname, '..', 'src', 'server.js')], {
    PORT: String(port),
    HOST: '127.0.0.1',
    UPSTREAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    UPSTREAM_API_KEY: SERVER_KEY,
    SSE_HEARTBEAT_MS: '600',
    UPSTREAM_HEADERS_TIMEOUT_MS: '6000',
    UPSTREAM_IDLE_TIMEOUT_MS: '4000',
    UPSTREAM_TOTAL_TIMEOUT_MS: '30000',
    UPSTREAM_RETRY_BASE_MS: '60',
    UPSTREAM_RETRY_MAX_MS: '300',
    ...extraEnv,
  }, name);
  const base = `http://127.0.0.1:${port}`;
  if (!await waitFor(`${base}/health`)) {
    app.child.kill();
    throw new Error(`${name} 启动失败\n${app.getLog().slice(-1500)}`);
  }
  return { app, base };
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
      const mock = spawnNode([path.join(__dirname, 'mock-upstream.js'), String(MOCK_PORT)], {}, 'mock');
      children.push(mock);
      if (!await waitFor(`http://127.0.0.1:${MOCK_PORT}/models`)) throw new Error('mock 上游启动失败\n' + mock.getLog());
      HAS_MOCK = true;
      const relay = await startRelayApp('app', APP_PORT, {});
      children.push(relay.app);
      BASE = relay.base;
    }
    console.log(`目标：${BASE}\n`);
    await loadKeys();

    // ---- S-00 ----
    const health = await jsonCall('GET', '/health');
    check('S-00a 健康检查暴露 stream 后端与 relay 状态',
      health.status === 200 && health.body.backends && health.body.backends.stream && health.body.relay,
      `backends=${JSON.stringify(health.body.backends)}`);
    check('S-00b 服务端已注入上游 Key（前端无从获取）',
      health.body.relay.upstreamConfigured === true && !health.text.includes(SERVER_KEY),
      `upstream=${health.body.relay.upstream}`);

    // ---- ① 登录 ----
    const token = await login('alice', 'Alice@Passw0rd');
    check('S-01a 登录签发 Opaque Token', typeof token === 'string' && token.length >= 42, `len=${token.length}`);

    // ---- S-02 先鉴权后推流 ----
    const noTok = await readStream('/v1/chat/stream', { body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } });
    check('S-02a 无 token → 401 TOKEN_MISSING 且响应非 SSE',
      noTok.status === 401 && !noTok.isSse && noTok.json && noTok.json.code === 'TOKEN_MISSING',
      `${noTok.status} ${noTok.json && noTok.json.code}`);

    const badTok = await readStream('/v1/chat/stream', { token: 'bogus-token', body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } });
    check('S-02b 坏 token → 401 TOKEN_INVALID 且未开始推流',
      badTok.status === 401 && !badTok.isSse && badTok.json.code === 'TOKEN_INVALID',
      `${badTok.status} ${badTok.json.code}`);

    // ---- S-01 / S-03 / S-10 正常流式 ----
    await resetMock();
    const s1 = await readStream('/v1/chat/stream', {
      token,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello stream' }], metadata: { mock: { tokens: 8, gap: 20 } } },
    });
    check('S-01 流式 200 + text/event-stream + 完整正文',
      s1.status === 200 && s1.isSse && s1.joined.startsWith('tok0 ') && s1.endData && s1.endData.status === 'done',
      `${s1.events.length} 帧 "${s1.joined.trim()}" ${s1.ms}ms`);
    check('S-03a 首帧 relay_meta 携带 requestId',
      s1.events[0] && s1.events[0].event === 'relay_meta' && safeJson(s1.events[0].data).requestId === s1.requestId,
      `X-Request-Id=${s1.requestId}`);
    const ids = s1.events.filter((e) => e.id !== null).map((e) => Number(e.id));
    check('S-03b 事件 id 从 1 起单调递增（Last-Event-ID 可用）',
      ids.length > 0 && ids[0] === 1 && ids.every((v, i) => i === 0 || v > ids[i - 1]),
      `${ids[0]}..${ids[ids.length - 1]}`);
    check('S-03c 响应头 X-Accel-Buffering:no（代理不缓冲 SSE）',
      s1.accelBuffering === 'no', `x-accel-buffering=${s1.accelBuffering || '(缺失)'}`);
    check('S-10a 下发内容中不含上游 Key',
      !s1.raw.includes(SERVER_KEY) && !s1.events.map((e) => e.data).join('').includes(SERVER_KEY));
    const calls1 = await callCount();
    check('S-10b 上游确实收到 Bearer Key（Key 只出现在服务端→上游这一跳）',
      calls1 < 0 || (calls1 === 1 && (await mockCalls())[0].hasAuth),
      calls1 < 0 ? '（外部 mock，跳过计数断言）' : `calls=${calls1}`);

    // ---- S-05 心跳 ----
    const hb = await readStream('/v1/chat/stream', {
      token,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hb' }], metadata: { mock: { tokens: 3, gap: 900 } } },
    });
    check('S-05 上游静默期间服务端写心跳注释行（: hb）',
      hb.raw.includes(': hb') && hb.endData && hb.endData.status === 'done',
      `心跳次数=${(hb.raw.match(/: hb/g) || []).length} ${hb.ms}ms`);

    // ---- S-04 断联重发（A 类：流中断）----
    await resetMock();
    const reqId = 'smoke_resume_' + crypto.randomBytes(6).toString('hex');
    const part1 = await readStream('/v1/chat/stream', {
      token, requestId: reqId,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'resume me' }], metadata: { mock: { tokens: 10, gap: 120 } } },
      stopAfterDeltas: 4,
    });
    check('S-04a 客户端中途断流：只收到部分增量',
      part1.aborted && part1.joined.length > 0 && !part1.joined.includes('tok9'),
      `已收 "${part1.joined.trim()}" lastId=${part1.lastEventId}`);

    await new Promise((r) => setTimeout(r, 1800)); // 等 producer 跑完
    const callsMid = await callCount();
    check('S-04b 断线后 producer 独立跑完，上游仍只被调用一次',
      callsMid < 0 || callsMid === 1, callsMid < 0 ? '（外部 mock，跳过）' : `calls=${callsMid}`);
    const stAfter = await jsonCall('GET', `/auth/me`, { token });
    check('S-04c 期间会话仍有效（心跳滑动续期，未被误判过期）',
      stAfter.status === 200, `${stAfter.status}`);

    const part2 = await readStream('/v1/chat/stream', { token, requestId: reqId, cursor: part1.lastEventId });
    check('S-04d 带 Last-Event-ID 续推 200 并补齐剩余增量',
      part2.status === 200 && part2.isSse && part2.joined.includes('tok9'),
      `续推 "${part2.joined.trim()}"`);
    check('S-04e 续推首帧晚于游标（不重复下发已收事件）',
      part2.events.every((e) => e.id === null || Number(e.id) > part1.lastEventId),
      `游标=${part1.lastEventId}`);
    const full = part1.joined + part2.joined;
    const expectFull = Array.from({ length: 10 }, (_, i) => `tok${i} `).join('');
    check('S-04f 两段拼接正好等于全文（无缺口、无重复）', full === expectFull, `"${full.trim()}"`);
    const callsAfter = await mockCalls();
    check('S-04g 续推不再打上游（不重复计费）', callsAfter.length === 1, `calls=${callsAfter.length}`);

    // ---- S-06 游标语义 ----
    const badCursor = await readStream('/v1/chat/stream', { token, requestId: reqId, cursor: 'abc' });
    check('S-06a 非法游标 → 400 CURSOR_INVALID（非 SSE）',
      badCursor.status === 400 && badCursor.json && badCursor.json.code === 'CURSOR_INVALID', `${badCursor.status}`);

    const ghost = await readStream('/v1/chat/stream', { token, requestId: 'ghost_stream_0001', cursor: 3 });
    check('S-06b 未知 requestId 续推 → 410 STREAM_EXPIRED',
      ghost.status === 410 && ghost.json.code === 'STREAM_EXPIRED', `${ghost.status} ${ghost.json.code}`);

    const ahead = await readStream('/v1/chat/stream', { token, requestId: reqId, cursor: 999999 });
    check('S-06c 游标超前：幂等收尾（200 + relay_end），不报错不重复',
      ahead.status === 200 && ahead.endData !== null && ahead.joined === '', `${ahead.status}`);

    const noCursor = await readStream('/v1/chat/stream', { token, requestId: reqId, body: { model: 'm', messages: [{ role: 'user', content: 'dup submit' }] } });
    check('S-06d 同 requestId 裸重发：幂等回放而非再打上游',
      noCursor.status === 200 && (await mockCalls()).length === callsAfter.length, `${noCursor.status}`);

    // ---- S-07 撤销与重登（C 类 → B 类）----
    await resetMock();
    const pair = await resolvePasswordPair('bob');
    const bobTok = await login('bob', pair.current);
    const bobStream = await readStream('/v1/chat/stream', {
      token: bobTok,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'bob first' }] },
    });
    check('S-07a bob 流式请求正常', bobStream.status === 200 && bobStream.endData.status === 'done', `${bobStream.status}`);

    const chg = await jsonCall('POST', '/auth/change-password', {
      token: bobTok,
      body: { encrypted: encrypt(encodeChange('bob', pair.current, pair.next)) },
    });
    check('S-07b 改密递增 credential_version', chg.status === 200 && chg.body.credentialVersion >= 2, JSON.stringify(chg.body));

    const revoked = await readStream('/v1/chat/stream', {
      token: bobTok,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'should fail' }] },
    });
    check('S-07c 改密后旧 token 的流式请求 → 401（撤销在推流之前生效）',
      revoked.status === 401 && !revoked.isSse && revoked.json.code === 'TOKEN_INVALID',
      `${revoked.status} ${revoked.json.code}`);

    const bobTok2 = await login('bob', pair.next);
    const retried = await readStream('/v1/chat/stream', {
      token: bobTok2,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'retry after relogin' }] },
    });
    check('S-07d 重登后新 token 重发未完成的数据请求成功（③-B）',
      retried.status === 200 && retried.joined.includes('tok0'), `${retried.status}`);

    // ---- S-08 缓存（独立进程：CACHE_ENABLED=1）----
    await checkCacheMode(children);

    // ---- S-09 熔断（独立进程：低阈值 + 关重试）----
    await checkBreakerMode(children);

    // ---- S-11 上游超时用 504 表达（idle 超时）----
    await checkTimeoutMode(children);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length) {
      console.log('失败项：');
      for (const f of failed) console.log('  - ' + f.name + (f.detail ? '  ' + f.detail : ''));
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('\n冒烟异常：', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    for (const c of children) { try { c.child.kill(); } catch { /* ignore */ } }
  }
}

/** 缓存模式：相同请求第二次不得再打上游，且回放正文一致 */
async function checkCacheMode(children) {
  let relay;
  try {
    relay = await startRelayApp('app-cache', APP_PORT + 1, { CACHE_ENABLED: '1', CACHE_TTL_MS: '120000' });
  } catch (e) {
    check('S-08 缓存模式服务启动', false, e.message); return;
  }
  children.push(relay.app);
  try {
    await resetMock();
    const tok = await login('alice', 'Alice@Passw0rd', relay.base);
    const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'cache me please' }] };
    const first = await readStream('/v1/chat/stream', { token: tok, body, base: relay.base });
    const calls1 = (await mockCalls()).length;
    const second = await readStream('/v1/chat/stream', { token: tok, body, base: relay.base });
    const calls2 = (await mockCalls()).length;

    check('S-08a 首次请求正常打上游一次', first.status === 200 && calls1 === 1, `status=${first.status} calls=${calls1}`);
    check('S-08b 相同请求命中缓存，不再打上游', second.status === 200 && calls2 === 1, `calls=${calls2}`);
    check('S-08c 命中回放的正文与首次一致',
      first.joined.length > 0 && second.joined === first.joined, `"${second.joined.trim()}"`);
    check('S-08d relay_end 标明 cached=true（可观测）',
      second.endData && second.endData.cached === true, JSON.stringify(second.endData));
  } catch (e) {
    check('S-08 缓存模式', false, e.message);
  } finally {
    relay.app.child.kill();
  }
}

/** 熔断模式：连续可重试失败达阈值后直接 503，且不再穿透上游 */
async function checkBreakerMode(children) {
  let relay;
  try {
    relay = await startRelayApp('app-breaker', APP_PORT + 2, {
      BREAKER_FAILURE_THRESHOLD: '2', BREAKER_WINDOW_MS: '120000', BREAKER_COOLDOWN_MS: '60000',
      UPSTREAM_RETRY_MAX: '0',
    });
  } catch (e) {
    check('S-09 熔断模式服务启动', false, e.message); return;
  }
  children.push(relay.app);
  try {
    await resetMock();
    const tok = await login('alice', 'Alice@Passw0rd', relay.base);
    const mk = () => ({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], metadata: { mock: { fail: 500 } } });

    const a = await readStream('/v1/chat/stream', { token: tok, body: mk(), base: relay.base });
    const b = await readStream('/v1/chat/stream', { token: tok, body: mk(), base: relay.base });
    const callsUpToNow = (await mockCalls()).length;
    const c = await readStream('/v1/chat/stream', { token: tok, body: mk(), base: relay.base });
    const callsAfterOpen = (await mockCalls()).length;

    check('S-09a 上游 5xx → 502 且响应非 SSE（真实状态码收场）',
      a.status === 502 && b.status === 502 && !a.isSse && !b.isSse, `${a.status}/${b.status}`);
    check('S-09b 失败达阈值后熔断打开 → 503 UPSTREAM_UNAVAILABLE',
      c.status === 503 && c.json && c.json.code === 'UPSTREAM_UNAVAILABLE', `${c.status} ${c.json && c.json.code}`);
    check('S-09c 熔断期间不再穿透上游', callsAfterOpen === callsUpToNow, `calls ${callsUpToNow} → ${callsAfterOpen}`);

    const st = await jsonCall('GET', '/v1/relay/stats', { token: tok, base: relay.base });
    check('S-09d /v1/relay/stats 暴露熔断状态与拒绝计数',
      st.status === 200 && st.body.breaker && st.body.breaker.state === 'open' && st.body.breaker.rejected > 0,
      JSON.stringify(st.body.breaker));
  } catch (e) {
    check('S-09 熔断模式', false, e.message);
  } finally {
    relay.app.child.kill();
  }
}

/** 超时模式：上游静默 → 504 UPSTREAM_TIMEOUT；上游断流不写 done */
async function checkTimeoutMode(children) {
  let relay;
  try {
    relay = await startRelayApp('app-timeout', APP_PORT + 3, {
      UPSTREAM_IDLE_TIMEOUT_MS: '1200', UPSTREAM_RETRY_MAX: '0', BREAKER_FAILURE_THRESHOLD: '20',
    });
  } catch (e) {
    check('S-11 超时模式服务启动', false, e.message); return;
  }
  children.push(relay.app);
  try {
    await resetMock();
    const tok = await login('alice', 'Alice@Passw0rd', relay.base);

    // 首帧之前的静默（先出 ping 才有帧，这里用 fail=500 之外的 idle：mock 先发 1 帧再静默）
    const idle = await readStream('/v1/chat/stream', {
      token: tok, base: relay.base,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'idle' }], metadata: { mock: { fail: 'idle' } } },
    });
    check('S-11a 上游静默触发 idle 超时，流以 error 收场（不误标 done）',
      idle.status === 200 && idle.endData && idle.endData.status === 'error'
      && /TIMEOUT|UPSTREAM/.test(idle.endData.code || ''),
      `end=${JSON.stringify(idle.endData)} ${idle.ms}ms`);

    const abortCase = await readStream('/v1/chat/stream', {
      token: tok, base: relay.base,
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'abort' }], metadata: { mock: { fail: 'abort', tokens: 3 } } },
    });
    check('S-11b 上游不发 message_stop 就断 → status=error，已收增量保留',
      abortCase.endData && abortCase.endData.status === 'error' && abortCase.joined.includes('tok2'),
      `joined="${abortCase.joined.trim()}" end=${JSON.stringify(abortCase.endData)}`);
    const callsTimeout = (await mockCalls()).length;
    check('S-11c 半截断流不重发上游请求（避免重复内容与计费）',
      callsTimeout === 2, `calls=${callsTimeout}`);
  } catch (e) {
    check('S-11 超时模式', false, e.message);
  } finally {
    relay.app.child.kill();
  }
}

main();
