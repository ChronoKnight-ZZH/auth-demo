'use strict';
/**
 * 中转链路测试：SSE 编解码、事件缓冲语义、熔断/退避、relay 端到端（真 http 上游 mock）。
 * 运行：node --test test/stream.test.js
 *
 * 与 unit.test.js 一样使用内存实现；Redis 分支在设置了 REDIS_URL 时追加一致性校验。
 */
process.env.PEPPER = process.env.PEPPER || 'test-pepper-0123456789abcdef';

const nodeTest = require('node:test');
require('../src/lib/fetch-global');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { encodeFrame, encodeComment, SseFrameParser } = require('../src/stream/sse');
const { MemoryEventBuffer } = require('../src/stream/memory-buffer');
const { CircuitBreaker, withRetry } = require('../src/lib/circuit-breaker');
const { normalizeBody, makeCacheKey, MemoryResponseCache } = require('../src/stream/cache');
const { config } = require('../src/config');

/**
 * Node 16 的 TestContext 没有 t.after()（18.8+ 才有）。这里补等价清理：
 * 测试体结束后逆序执行，确保 mock server / 定时器被关闭，测试进程能退出。
 */
function test(name, fn) {
  return nodeTest(name, async (t) => {
    if (typeof t.after === 'function') return fn(t);
    const hooks = [];
    t.after = (hook) => { hooks.push(hook); };
    try {
      return await fn(t);
    } finally {
      for (const hook of hooks.reverse()) {
        try { await hook(); } catch { /* 清理失败不影响断言结果 */ }
      }
    }
  });
}
test.before = nodeTest.before;
test.after = nodeTest.after;

// ---------------------------------------------------------------- SSE 编解码

test('SSE 编码：id/event/data 与空行分隔符合规范', () => {
  const f = encodeFrame({ id: 7, event: 'content_block_delta', data: '{"a":1}' });
  assert.strictEqual(f, 'id: 7\nevent: content_block_delta\ndata: {"a":1}\n\n');
});

test('SSE 编码：data 含换行必须拆成多行，不能被对端当空行派发', () => {
  const f = encodeFrame({ id: 1, data: 'line1\nline2' });
  assert.strictEqual(f, 'id: 1\ndata: line1\ndata: line2\n\n');
});

test('SSE 编码：注释行以 : 开头且自带终止空行', () => {
  assert.strictEqual(encodeComment('hb'), ': hb\n\n');
  assert.strictEqual(encodeComment('a\nb'), ': a b\n\n', '注释中的换行必须被替换');
});

test('SSE 解析：与前端 sse.ts 同源语义（CRLF/CR/LF、多行 data、注释忽略、id 保留）', () => {
  const p = new SseFrameParser();
  let out = p.push('event: message_start\r\ndata: {"a":1}\r\n\r\n');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].event, 'message_start');
  assert.strictEqual(out[0].data, '{"a":1}');

  // 跨分片：行被切成两段
  out = p.push('data: {"b":');
  assert.strictEqual(out.length, 0);
  out = p.push('2}\ndata: tail\n\n');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].data, '{"b":2}\ntail', '多行 data 以 \\n 连接');

  // 注释与 retry 不产出事件
  out = p.push(': keep-alive\nretry: 3000\n\n');
  assert.strictEqual(out.length, 0);

  // CR 结尾 + 未以空行收尾的残帧按规范丢弃
  p.push('data: dropped');
  assert.deepStrictEqual(p.end(), []);
});

test('SSE 编解码往返：encodeFrame 的输出能被 SseFrameParser 原样解出', () => {
  const p = new SseFrameParser();
  const frames = [
    { id: 1, event: 'message_start', data: JSON.stringify({ type: 'message_start', usage: { input_tokens: 1 } }) },
    { id: 2, event: 'content_block_delta', data: JSON.stringify({ delta: { text: '你好 🌍' } }) },
    { id: 3, event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
  ];
  let got = [];
  for (const f of frames) got = got.concat(p.push(encodeFrame(f)));
  assert.strictEqual(got.length, 3);
  assert.deepStrictEqual(got.map((e) => e.event), ['message_start', 'content_block_delta', 'message_stop']);
  assert.strictEqual(JSON.parse(got[1].data).delta.text, '你好 🌍');
});

// ---------------------------------------------------------------- 事件缓冲语义

function newBuffer() {
  return new MemoryEventBuffer({ maxEvents: 6, maxBytes: 100_000, ttlMs: 60_000 });
}

function newMemory(maxEvents) {
  return new MemoryEventBuffer({ maxEvents, maxBytes: 1_000_000, ttlMs: 60_000 });
}

test('缓冲：id 单调递增，游标读取只返回之后的事件', async () => {
  const b = newBuffer();
  await b.create('s1', { userId: 1, requestId: 's1', bodyHash: 'h' });
  for (let i = 0; i < 4; i++) await b.append('s1', { event: 'content_block_delta', data: `d${i}` });
  const r = await b.read('s1', 2, 100);
  assert.deepStrictEqual(r.items.map((f) => f.data), ['d2', 'd3'], 'cursor=2 即从 id 3 起');
  assert.strictEqual(r.count, 4);
  assert.strictEqual(r.firstId, 1);
  assert.strictEqual(r.truncated, false);
  await b.close();
});

test('缓冲：游标早于缓冲起点时 truncated=true（前端需整条重发）', async () => {
  const b = newBuffer();
  await b.create('s2', { userId: 1, requestId: 's2', bodyHash: 'h' });
  for (let i = 0; i < 10; i++) await b.append('s2', { event: 'delta', data: `x${i}` });
  const st = await b.getState('s2');
  assert.ok(st.firstId > 1, `超出上限必须从头截断，实际 firstId=${st.firstId}`);
  assert.strictEqual(st.count, 10, '已分配的 id 不因截断而回退');
  const r = await b.read('s2', 0, 100);
  assert.strictEqual(r.truncated, true);
  // 从当前起点接上
  const ok = await b.read('s2', st.firstId - 1, 100);
  assert.strictEqual(ok.truncated, false);
  assert.strictEqual(ok.items[0].id, st.firstId);
  await b.close();
});

test('缓冲：finish 后 read 仍可用（TTL 内可续推/回放）', async () => {
  const b = newBuffer();
  await b.create('s3', { userId: 1, requestId: 's3', bodyHash: 'h' });
  await b.append('s3', { event: 'message_stop', data: '{}' });
  await b.finish('s3', 'done', { finishReason: 'end_turn' });
  const st = await b.getState('s3');
  assert.strictEqual(st.status, 'done');
  assert.strictEqual(st.finishReason, 'end_turn');
  const r = await b.read('s3', 0, 10);
  assert.strictEqual(r.items.length, 1);
  await b.close();
});

test('缓冲：TTL 过期即消失（read/getState 返回 null → 上层 410 STREAM_EXPIRED）', async () => {
  const b = new MemoryEventBuffer({ maxEvents: 10, maxBytes: 100_000, ttlMs: 30 });
  await b.create('s4', { userId: 1, requestId: 's4', bodyHash: 'h' });
  await b.append('s4', { event: 'delta', data: 'x' });
  assert.ok(await b.getState('s4'));
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(await b.getState('s4'), null);
  assert.strictEqual(await b.read('s4', 0, 10), null);
  await b.close();
});

test('字节上限截断：不丢当前帧，只回收更早的历史', async () => {
  const b = new MemoryEventBuffer({ maxEvents: 1000, maxBytes: 120, ttlMs: 60_000 });
  await b.create('s5', { userId: 1, requestId: 's5', bodyHash: 'h' });
  for (let i = 0; i < 8; i++) await b.append('s5', { event: 'delta', data: 'A'.repeat(40) + i });
  const st = await b.getState('s5');
  assert.strictEqual(st.count, 8);
  assert.ok(st.firstId > 1, '字节超限必须截断头部');
  const last = await b.read('s5', st.count - 1, 10);
  assert.strictEqual(last.items.length, 1, '最新帧必须仍在');
  await b.close();
});

test('缓冲：append 到不存在的流返回 null（生产者据此停止）', async () => {
  const b = newBuffer();
  assert.strictEqual(await b.append('ghost', { event: 'delta', data: 'x' }), null);
  await b.close();
});

test('缓冲：create 幂等，不覆盖已有缓冲', async () => {
  const b = newBuffer();
  await b.create('s6', { userId: 1, requestId: 's6', bodyHash: 'h' });
  await b.append('s6', { event: 'delta', data: 'keep' });
  await b.create('s6', { userId: 1, requestId: 's6', bodyHash: 'h2' });
  const st = await b.getState('s6');
  assert.strictEqual(st.count, 1, '重复 create 不得清空缓冲');
  await b.close();
});

// ---------------------------------------------------------------- 缓存

test('缓存：键含 userId（默认不跨用户复用），请求体规整忽略无关字段', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, extra: 1 };
  const k1 = makeCacheKey(1, body);
  const k2 = makeCacheKey(2, body);
  const k3 = makeCacheKey(1, { ...body, messages: [{ role: 'user', content: 'hi!' }] });
  assert.notStrictEqual(k1, k2, '不同用户不得共享缓存');
  assert.notStrictEqual(k1, k3);
  const norm = JSON.parse(normalizeBody(body));
  assert.strictEqual(norm.stream, true, 'stream 归一化');
  assert.strictEqual(norm.extra, undefined, '未知字段不参与缓存键');
});

test('缓存：超过单条上限不写入，正常写入可回读且带 TTL 过期', async () => {
  const c = new MemoryResponseCache({ ttlMs: 40, maxEntryBytes: 200 });
  assert.strictEqual(await c.set('k', { frames: [{ event: 'x', data: 'A'.repeat(300) }], bytes: 300 }), false);
  assert.strictEqual(await c.set('k', { frames: [{ event: 'x', data: 'ok' }], bytes: 20 }), true);
  assert.strictEqual((await c.get('k')).frames[0].data, 'ok');
  await new Promise((r) => setTimeout(r, 70));
  assert.strictEqual(await c.get('k'), null);
  await c.close();
});

// ---------------------------------------------------------------- 熔断 / 退避

test('熔断器：滑动窗口失败达阈值打开，冷却后半开，试探成功即恢复', async () => {
  const br = new CircuitBreaker({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 40 });
  assert.strictEqual(br.allow(), true);
  br.recordFailure(new Error('t'));
  assert.strictEqual(br.state, 'closed', '未达阈值不得打开');
  br.recordFailure(new Error('t'));
  assert.strictEqual(br.state, 'open');
  assert.strictEqual(br.allow(), false, 'open 期间拒绝');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(br.allow(), true, '冷却到期进入 half-open 并放行探针');
  assert.strictEqual(br.allow(), false, 'half-open 只允许一个探针');
  br.recordSuccess();
  assert.strictEqual(br.state, 'closed');
});

test('熔断器：half-open 探针失败立刻重新打开', async () => {
  const br = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 20 });
  br.recordFailure(new Error('t'));
  assert.strictEqual(br.state, 'open');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(br.allow(), true);
  br.recordFailure(new Error('t'));
  assert.strictEqual(br.state, 'open');
});

test('重试：只对 retryable 退避重试，不可重试立即抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      const e = new Error('rejected by upstream');
      e.code = 'UPSTREAM_REJECTED';
      e.retryable = false;
      throw e;
    }, { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 5 }),
    /rejected by upstream/
  );
  assert.strictEqual(calls, 1, '不可重试类不得重试（避免重复计费）');

  let n = 0;
  const ok = await withRetry(async () => {
    n += 1;
    if (n < 3) { const e = new Error('timeout'); e.code = 'UPSTREAM_TIMEOUT'; e.retryable = true; throw e; }
    return 'done';
  }, { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 5 });
  assert.strictEqual(ok, 'done');
  assert.strictEqual(n, 3);
});

test('重试：中止信号在尝试之间生效，不再打上游', async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      controller.abort();
      const e = new Error('x');
      e.retryable = true;
      throw e;
    }, { maxAttempts: 5, baseBackoffMs: 1, shouldAbort: () => controller.signal.aborted }),
    /aborted/
  );
  assert.strictEqual(calls, 1);
});

// ---------------------------------------------------------------- relay 纯函数

const { RelayService } = require('../src/stream/relay-service');

test('relay：请求体校验挡住空/未知模型', () => {
  const r = new RelayService({ buffer: newBuffer() });
  const isCode = (code) => (e) => e && e.code === code;
  assert.throws(() => r.validateBody(null), isCode('INVALID_INPUT'));
  assert.throws(() => r.validateBody({ model: 'm' }), isCode('INVALID_INPUT'));
  assert.throws(() => r.validateBody({ model: 'm', messages: [] }), isCode('INVALID_INPUT'));
  assert.ok(r.validateBody({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
  // 模型白名单
  config.upstream.allowedModels = ['allow-me'];
  assert.throws(
    () => r.validateBody({ model: 'other', messages: [{ role: 'user', content: 'x' }] }),
    isCode('MODEL_NOT_ALLOWED')
  );
  config.upstream.allowedModels = [];
});

test('relay：只转发白名单字段，前端塞入的未知字段不进上游', () => {
  const r = new RelayService({ buffer: newBuffer() });
  const out = r.sanitizeToUpstream({
    model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false,
    temperature: 0.2, evil: 'drop', proxy: 'nope',
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['messages', 'model', 'stream', 'temperature']);
  assert.strictEqual(out.stream, true, '强制流式');
});

test('relay：游标解析（Last-Event-ID 优先、非法拒绝、缺省为 0）', () => {
  const r = new RelayService({ buffer: newBuffer() });
  assert.deepStrictEqual(r.parseCursor({ headers: {}, query: {} }), { cursor: 0, explicit: false });
  assert.deepStrictEqual(r.parseCursor({ headers: { 'last-event-id': '12' }, query: {} }), { cursor: 12, explicit: true });
  assert.deepStrictEqual(r.parseCursor({ headers: {}, query: { cursor: '4' } }), { cursor: 4, explicit: true });
  assert.throws(() => r.parseCursor({ headers: { 'last-event-id': 'abc' }, query: {} }), (e) => e.code === 'CURSOR_INVALID');
  assert.throws(() => r.parseCursor({ headers: { 'last-event-id': '999999999999999999' }, query: {} }), (e) => e.code === 'CURSOR_INVALID');
});

test('relay：requestId 复用前端值或随机生成，格式受限', () => {
  const r = new RelayService({ buffer: newBuffer() });
  assert.strictEqual(r.resolveRequestId({ headers: { 'x-request-id': 'req_abc12345' }, query: {} }, {}), 'req_abc12345');
  assert.strictEqual(r.resolveRequestId({ headers: {}, query: { requestId: 'q12345678' } }, {}), 'q12345678');
  assert.match(r.resolveRequestId({ headers: {}, query: {} }, {}), /^[A-Za-z0-9_-]{16}$/);
  assert.throws(() => r.resolveRequestId({ headers: { 'x-request-id': 'bad id/../..' }, query: {} }, {}), (e) => e.code === 'INVALID_INPUT');
});

// ---------------------------------------------------------------- relay 端到端

/**
 * 上游 mock：可控故障。
 * 故障通过 body.metadata 注入 —— relay 的字段白名单只放行 metadata，
 * 这同时证明了「前端无法用任意 header 操纵上游」这条安全性质。
 */
function startMockUpstream() {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/anthropic/v1/messages') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      const auth = req.headers.authorization || '';
      const mock = (body.metadata && body.metadata.mock) || {};
      const fail = mock.fail || '';
      state.calls.push({ auth, fail, body });
      if (fail === '500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
      if (fail === '400') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad"}}'); }
      if (fail === 'network') { req.socket.destroy(); return; }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);
      sse('message_start', JSON.stringify({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }));
      const stopAt = Number(mock.stopAt || 0);
      const gap = Number(mock.gap || 5);
      for (let i = 0; i < 6; i++) {
        sse('content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `t${i} ` } }));
        if (stopAt && i + 1 >= stopAt) return res.end(); // 不发 message_stop 就断
        await new Promise((r) => setTimeout(r, gap));
      }
      sse('content_block_stop', '{"type":"content_block_stop","index":0}');
      sse('message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      sse('message_stop', '{"type":"message_stop"}');
      res.end();
    } else if (req.url === '/models') {
      res.writeHead(req.headers.authorization ? 200 : 401, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    } else { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

/** 最小 req/res 替身：足够覆盖 relay 用到的 API */
function makeReqRes({ headers = {}, query = {}, body = {}, userId = 1 } = {}) {
  const req = new EventEmitter();
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  req.query = query;
  req.body = body;
  req.userId = userId;
  req.touchSession = null;

  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks: '',
    _headers: {},
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    getHeader(k) { return this._headers[k.toLowerCase()]; },
    writeHead(code, h) { this.statusCode = code; Object.assign(this._headers, mapKeys(h)); this.headersSent = true; return this; },
    flushHeaders() { this.headersSent = true; },
    write(s) { if (this.writableEnded || this.destroyed) return false; this.chunks += s; return true; },
    end(s) { if (s) this.chunks += s; this.writableEnded = true; this.emit('end'); return this; },
    json(o) {
      // sendError 先 status(code) 再 json()；writeHead 不得把已设定的状态码覆盖成 200
      const code = this.statusCode || 200;
      this.writeHead(code, { 'content-type': 'application/json' });
      this.chunks += JSON.stringify(o);
      this.writableEnded = true;
      return this;
    },
    status(c) { this.statusCode = c; return this; },
    destroy() { this.destroyed = true; },
  };
  Object.setPrototypeOf(res, EventEmitter.prototype);
  return { req, res };
}

function mapKeys(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * 模拟路由层收口：handle() 抛出的 AppError 在真实链路由 errorHandler 转成
 * 「未推流 → 普通 HTTP 状态码」。测试必须走同一条收口，否则 401/502/410
 * 会测成异常穿透。
 */
async function runRelay(relay, req, res) {
  const { sendError } = require('../src/lib/errors');
  try {
    await relay.handle(req, res);
  } catch (e) {
    if (res.headersSent) throw e;
    sendError(res, e instanceof Error && e.code ? e.code : 'INTERNAL');
  }
  return res;
}

/** 把已收集的 SSE 文本解成事件列表 */
function parseEvents(text) {
  const p = new SseFrameParser();
  const out = p.push(text);
  return out.concat(p.end());
}

function pointUpstream(mock, apiKey = 'sk-test-secret-key') {
  config.upstream.baseUrl = `http://127.0.0.1:${mock.port}`;
  config.upstream.apiKey = apiKey;
}

const CHAT_BODY = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

test('relay E2E：新开流 → 事件带递增 id 下发并以 relay_end 收尾', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  const requestId = 'e2e_' + crypto.randomBytes(6).toString('hex');

  const relay = new RelayService({ buffer: newMemory(200) });
  const { req, res } = makeReqRes({ headers: { 'x-request-id': requestId }, body: CHAT_BODY });
  await runRelay(relay, req, res);

  assert.strictEqual(res.statusCode, 200, '推流以 200 + SSE 开始');
  assert.match(res.getHeader('content-type'), /text\/event-stream/);
  assert.strictEqual(res.getHeader('x-accel-buffering'), 'no', '必须关掉代理缓冲');
  const events = parseEvents(res.chunks);
  const meta = events.find((e) => e.event === 'relay_meta');
  assert.ok(meta, 'relay_meta 首帧');
  assert.strictEqual(JSON.parse(meta.data).requestId, requestId);
  const deltas = events.filter((e) => e.event === 'content_block_delta');
  assert.strictEqual(deltas.length, 6);
  const ids = deltas.map((e) => Number(e.lastEventId));
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'id 必须递增');
  assert.ok(!res.chunks.includes('sk-test-secret-key'), '上游 Key 绝不出现在响应里');

  const end = events.find((e) => e.event === 'relay_end');
  assert.ok(end && end.data.includes('"status":"done"'));

  // 上游确实收到了 Bearer Key（Key 只出现在服务端→上游这一跳）
  assert.ok(mock.state.calls.length >= 1 && mock.state.calls[0].auth.startsWith('Bearer '));
  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：上游 5xx 在首帧之前以 HTTP 502 返回，绝不写出 SSE 头', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);

  const relay = new RelayService({ buffer: newMemory(200) });
  const { req, res } = makeReqRes({
    headers: { 'x-request-id': 'e2e500_' + crypto.randomBytes(4).toString('hex') },
    body: { ...CHAT_BODY, metadata: { mock: { fail: '500' } } },
  });
  await runRelay(relay, req, res);
  assert.strictEqual(res.statusCode, 502, 'preflight 阶段用真实状态码');
  assert.match(String(res.getHeader('content-type')), /application\/json/, '失败收场必须是 JSON，不得伪装成 SSE');
  assert.ok(!res.chunks.includes('event:'), '不得下发任何 SSE 事件帧');
  assert.match(res.chunks, /UPSTREAM_/);
  // 上游 5xx 属可重试类：重试次数受配置约束（默认 maxAttempts=2 → 最多 3 次打上游）
  assert.ok(mock.state.calls.length >= 2, `上游 5xx 应触发退避重试，实得 ${mock.state.calls.length} 次`);
  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：断线续推 —— 已下发的事件不重复，未下发的补齐', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  const requestId = 'resume_' + crypto.randomBytes(6).toString('hex');
  const relay = new RelayService({ buffer: newMemory(200) });

  // 1) 第一条 tail：写到第 4 帧就「断线」
  const first = makeReqRes({ headers: { 'x-request-id': requestId }, body: { ...CHAT_BODY, metadata: { mock: { gap: 40 } } } });
  let seen = 0;
  const origWrite = first.res.write.bind(first.res);
  first.res.write = (s) => {
    origWrite(s);
    seen += (s.match(/\n\n/g) || []).length;
    if (seen >= 4) first.req.emit('close');
    return true;
  };
  await runRelay(relay, first.req, first.res);
  const got1 = parseEvents(first.res.chunks).filter((e) => e.event === 'content_block_delta');
  assert.ok(got1.length >= 1 && got1.length < 6, `第一条 tail 应中途断开，实收 ${got1.length}`);
  const lastId = Number(got1[got1.length - 1].lastEventId);

  // 2) 生产者在浏览器断开后继续跑完（时序图 ③-A 的前提）
  await new Promise((r) => setTimeout(r, 600));
  const st = await relay.buffer.getState(requestId);
  assert.strictEqual(st.status, 'done', 'tail 断开不影响 producer 跑完');
  assert.strictEqual(mock.state.calls.length, 1, '上游只被打了一次，未重复计费');

  // 3) 带 Last-Event-ID 重连：只补后续事件
  const second = makeReqRes({ headers: { 'x-request-id': requestId, 'last-event-id': String(lastId) } });
  await runRelay(relay, second.req, second.res);
  const got2 = parseEvents(second.res.chunks).filter((e) => e.event === 'content_block_delta');
  assert.ok(got2.length > 0, '续推必须拿到未收到的部分');
  assert.ok(Number(got2[0].lastEventId) > lastId, '续推首帧必须晚于游标');
  const allText = [...got1, ...got2].map((e) => JSON.parse(e.data).delta.text).join('');
  assert.strictEqual(allText, 't0 t1 t2 t3 t4 t5 ', '两段拼接正好等于全文，无缺口无重复');
  assert.strictEqual(mock.state.calls.length, 1, '续推不得再次打上游');

  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：续推别人的 requestId → 410，不泄露其内容', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  const requestId = 'owner_' + crypto.randomBytes(6).toString('hex');
  const relay = new RelayService({ buffer: newMemory(200) });

  const mine = makeReqRes({ headers: { 'x-request-id': requestId }, body: CHAT_BODY, userId: 1 });
  await runRelay(relay, mine.req, mine.res);

  // 续推路径（带游标）：410，且不回吐任何内容
  const other = makeReqRes({ headers: { 'x-request-id': requestId, 'last-event-id': '1' }, userId: 2 });
  await runRelay(relay, other.req, other.res);
  assert.strictEqual(other.res.statusCode, 410);
  assert.match(other.res.chunks, /STREAM_EXPIRED/);
  assert.ok(!other.res.chunks.includes('t0'), '不得回吐他人内容');

  // 裸提交路径（不带游标）撞同一 requestId：拒绝且不回放
  const thief = makeReqRes({ headers: { 'x-request-id': requestId }, body: CHAT_BODY, userId: 3 });
  await runRelay(relay, thief.req, thief.res);
  assert.ok(thief.res.statusCode >= 400, `撞他人 requestId 必须被拒，实得 ${thief.res.statusCode}`);
  assert.ok(!thief.res.chunks.includes('t0'), '撞库路径同样不得回放内容');

  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：缓存命中不再打上游，回放同样带完整事件序列', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  config.cache.enabled = true;
  t.after(() => { config.cache.enabled = false; });

  const cache = new MemoryResponseCache({ ttlMs: 60_000, maxEntryBytes: 1_000_000 });
  const relay = new RelayService({ buffer: newMemory(200), cache });
  const body = { model: 'm', messages: [{ role: 'user', content: 'cached?' }] };

  const r1 = makeReqRes({ headers: { 'x-request-id': 'c1_' + crypto.randomBytes(4).toString('hex') }, body });
  await runRelay(relay, r1.req, r1.res);
  assert.strictEqual(mock.state.calls.length, 1);

  const r2 = makeReqRes({ headers: { 'x-request-id': 'c2_' + crypto.randomBytes(4).toString('hex') }, body });
  await runRelay(relay, r2.req, r2.res);
  assert.strictEqual(mock.state.calls.length, 1, '相同请求命中缓存，不再打上游');
  const ev = parseEvents(r2.res.chunks).filter((e) => e.event === 'content_block_delta');
  assert.strictEqual(ev.length, 6);
  assert.ok(r2.res.chunks.includes('"cached":true'), 'relay_end 标明来自缓存');

  config.cache.enabled = false;
  await relay.stopAll();
  await relay.buffer.close();
  await cache.close();
});

test('relay E2E：缓存不跨用户命中', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  config.cache.enabled = true;
  t.after(() => { config.cache.enabled = false; });

  const cache = new MemoryResponseCache({ ttlMs: 60_000, maxEntryBytes: 1_000_000 });
  const relay = new RelayService({ buffer: newMemory(200), cache });
  const body = { model: 'm', messages: [{ role: 'user', content: 'same text' }] };

  const a = makeReqRes({ headers: { 'x-request-id': 'cu1_' + crypto.randomBytes(4).toString('hex') }, body, userId: 1 });
  await runRelay(relay, a.req, a.res);
  const b = makeReqRes({ headers: { 'x-request-id': 'cu2_' + crypto.randomBytes(4).toString('hex') }, body, userId: 2 });
  await runRelay(relay, b.req, b.res);
  assert.strictEqual(mock.state.calls.length, 2, '不同用户不得共享缓存（默认边界）');

  config.cache.enabled = false;
  await relay.stopAll();
  await relay.buffer.close();
  await cache.close();
});

test('relay E2E：并发闸 —— 超出 maxPerUser 返回 429 RELAY_BUSY', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  const savedPerUser = config.stream.maxPerUser;
  config.stream.maxPerUser = 1;
  t.after(() => { config.stream.maxPerUser = savedPerUser; });

  const relay = new RelayService({ buffer: newMemory(200) });
  const slow = { ...CHAT_BODY, metadata: { mock: { gap: 80 } } };
  const first = makeReqRes({ headers: { 'x-request-id': 'gate1_' + crypto.randomBytes(4).toString('hex') }, body: slow });
  const p1 = runRelay(relay, first.req, first.res);
  await new Promise((r) => setTimeout(r, 30)); // 让 producer 挂上
  const second = makeReqRes({ headers: { 'x-request-id': 'gate2_' + crypto.randomBytes(4).toString('hex') }, body: slow });
  await runRelay(relay, second.req, second.res);
  assert.strictEqual(second.res.statusCode, 429, '超额度用 429，前端按退避重试');
  assert.match(second.res.chunks, /RELAY_BUSY/);
  await p1;

  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：上游 400 不重试、不熔断，以 502/UPSTREAM_REJECTED 收场（避免坏请求打爆上游）', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);

  const relay = new RelayService({ buffer: newMemory(200) });
  const { req, res } = makeReqRes({
    headers: { 'x-request-id': 'e2e400_' + crypto.randomBytes(4).toString('hex') },
    body: { ...CHAT_BODY, metadata: { mock: { fail: '400' } } },
  });
  await runRelay(relay, req, res);
  assert.strictEqual(res.statusCode, 502);
  assert.match(res.chunks, /UPSTREAM_REJECTED/);
  assert.strictEqual(mock.state.calls.length, 1, '上游 4xx 是请求自身的问题，不得重试');
  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：已产出 token 后上游断流 → 不重复打上游（避免重复计费），只标记中断', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);

  const relay = new RelayService({ buffer: newMemory(200) });
  const { req, res } = makeReqRes({
    headers: { 'x-request-id': 'half_' + crypto.randomBytes(4).toString('hex') },
    body: { ...CHAT_BODY, metadata: { mock: { stopAt: 3 } } },
  });
  await runRelay(relay, req, res);
  assert.strictEqual(mock.state.calls.length, 1, '半截之后只能续推，绝不重发上游请求');
  const got = parseEvents(res.chunks).filter((e) => e.event === 'content_block_delta');
  assert.strictEqual(got.length, 3, '已产出的 3 个增量必须完整下发，不丢弃');
  const end = parseEvents(res.chunks).find((e) => e.event === 'relay_end');
  assert.strictEqual(JSON.parse(end.data).status, 'error');
  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：熔断打开后直接 503，不再打上游', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  const saved = { th: config.stream.circuit.failureThreshold, cd: config.stream.circuit.cooldownMs, ra: config.stream.retry.maxAttempts };
  config.stream.circuit.failureThreshold = 1;
  config.stream.retry.maxAttempts = 0;
  t.after(() => {
    config.stream.circuit.failureThreshold = saved.th;
    config.stream.retry.maxAttempts = saved.ra;
    config.stream.circuit.cooldownMs = saved.cd;
  });

  const relay = new RelayService({ buffer: newMemory(200) });
  const bad = { ...CHAT_BODY, metadata: { mock: { fail: '500' } } };
  const r1 = makeReqRes({ headers: { 'x-request-id': 'cb1_' + crypto.randomBytes(4).toString('hex') }, body: bad });
  await runRelay(relay, r1.req, r1.res);
  const afterFirst = mock.state.calls.length;

  const r2 = makeReqRes({ headers: { 'x-request-id': 'cb2_' + crypto.randomBytes(4).toString('hex') }, body: bad });
  await runRelay(relay, r2.req, r2.res);
  assert.strictEqual(r2.res.statusCode, 503, '熔断 open 期间直接拒绝');
  assert.match(r2.res.chunks, /UPSTREAM_UNAVAILABLE/);
  assert.strictEqual(mock.state.calls.length, afterFirst, '熔断期间绝不放请求到上游');
  assert.strictEqual(relay.breaker.state, 'open');

  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：游标早于缓冲起点 → 410 CURSOR_EXPIRED（要求整条重发）', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  const requestId = 'trunc_' + crypto.randomBytes(6).toString('hex');
  // 只留 2 个事件的缓冲：任何长流都会被截断
  const relay = new RelayService({ buffer: newMemory(2) });

  const first = makeReqRes({ headers: { 'x-request-id': requestId }, body: CHAT_BODY });
  await runRelay(relay, first.req, first.res);
  const st = await relay.buffer.getState(requestId);
  assert.ok(st.firstId > 1, '缓冲应已从头截断');

  const old = makeReqRes({ headers: { 'x-request-id': requestId, 'last-event-id': '0' } });
  await runRelay(relay, old.req, old.res);
  assert.strictEqual(old.res.statusCode, 410);
  assert.match(old.res.chunks, /CURSOR_EXPIRED/);

  // 从现存起点接上是正常的
  const ok = makeReqRes({ headers: { 'x-request-id': requestId, 'last-event-id': String(st.firstId - 1) } });
  await runRelay(relay, ok.req, ok.res);
  assert.strictEqual(ok.res.statusCode, 200);
  await relay.stopAll();
  await relay.buffer.close();
});

test('relay E2E：非法游标 → 400，非法 requestId → 400，不进入缓冲查询', async (t) => {
  const relay = new RelayService({ buffer: newMemory(10) });
  t.after(() => relay.buffer.close());

  const bad = makeReqRes({ headers: { 'last-event-id': 'not-a-number' } });
  await runRelay(relay, bad.req, bad.res);
  assert.strictEqual(bad.res.statusCode, 400);
  assert.match(bad.res.chunks, /CURSOR_INVALID/);

  const badId = makeReqRes({ headers: { 'x-request-id': '../etc/passwd' }, body: CHAT_BODY });
  await runRelay(relay, badId.req, badId.res);
  assert.strictEqual(badId.res.statusCode, 400);
  assert.match(badId.res.chunks, /INVALID_INPUT/);
});

test('relay E2E：上游不发 message_stop 就断 → 流以 error 收场，且不写缓存', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock);
  config.cache.enabled = true;
  t.after(() => { config.cache.enabled = false; });

  const cache = new MemoryResponseCache({ ttlMs: 60_000, maxEntryBytes: 1_000_000 });
  const relay = new RelayService({ buffer: newMemory(200), cache });
  const body = { ...CHAT_BODY, metadata: { mock: { stopAt: 2 } } };
  const r = makeReqRes({ headers: { 'x-request-id': 'brk_' + crypto.randomBytes(4).toString('hex') }, body });
  await runRelay(relay, r.req, r.res);
  const events = parseEvents(r.res.chunks);
  const end = events.find((e) => e.event === 'relay_end');
  assert.ok(end, '必须有终止帧');
  const endObj = JSON.parse(end.data);
  assert.strictEqual(endObj.status, 'error', '无终止帧的上游断流不得标成 done');
  const cached = await cache.get(makeCacheKey(1, relay.sanitizeToUpstream(body)));
  assert.strictEqual(cached, null, '残片不得进缓存');

  await relay.stopAll();
  await relay.buffer.close();
  await cache.close();
});

test('relay E2E：未配 UPSTREAM_API_KEY → 503，不碰上游', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.server.close());
  pointUpstream(mock, '');

  const relay = new RelayService({ buffer: newMemory(200) });
  const { req, res } = makeReqRes({ headers: { 'x-request-id': 'nokey_' + crypto.randomBytes(4).toString('hex') }, body: CHAT_BODY });
  await runRelay(relay, req, res);
  assert.strictEqual(res.statusCode, 503);
  assert.match(res.chunks, /UPSTREAM_NOT_CONFIGURED/);
  assert.strictEqual(mock.state.calls.length, 0);
  await relay.buffer.close();
});

// ---------------------------------------------------------------- Redis 分支（需真实 Redis）

const redisUrl = process.env.REDIS_URL || '';
test(`RedisStreamBuffer 与内存实现语义一致${redisUrl ? '' : '（未设 REDIS_URL，跳过）'}`, async (t) => {
  if (!redisUrl) return t.skip();
  const { RedisStreamBuffer } = require('../src/stream/redis-buffer');
  const b = new RedisStreamBuffer(redisUrl, { maxEvents: 6, maxBytes: 1_000_000, ttlMs: 60_000 });
  const id = 'rt_' + crypto.randomBytes(6).toString('hex');
  await b.create(id, { userId: 9, requestId: id, bodyHash: 'h' });
  for (let i = 0; i < 10; i++) await b.append(id, { event: 'delta', data: `d${i}` });
  const st = await b.getState(id);
  assert.strictEqual(st.count, 10);
  assert.ok(st.firstId > 1, 'Lua 截断必须推进 firstId');
  const r = await b.read(id, st.firstId - 1, 100);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.items[r.items.length - 1].data, 'd9', '最新帧必须在');
  const gone = await b.read(id, 0, 100);
  assert.strictEqual(gone.truncated, true, '游标早于起点必须判截断');
  await b.finish(id, 'done', { finishReason: 'end_turn' });
  const st2 = await b.getState(id);
  assert.strictEqual(st2.status, 'done');
  assert.strictEqual(st2.finishReason, 'end_turn');
  await b.close();
});
