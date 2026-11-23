'use strict';
/**
 * DeepSeek 兼容上游的本地模拟器（离线跑通中转/续推/熔断全链路）。
 *
 * 用法：node scripts/mock-upstream.js [port]     默认 8787
 *   .env 设 UPSTREAM_BASE_URL=http://127.0.0.1:8787 后，中转链路即可端到端测试；
 *   换回真实 DeepSeek 只需改 UPSTREAM_BASE_URL 并填 UPSTREAM_API_KEY，业务代码零改动。
 *
 * 故障注入通过请求体的 metadata.mock 传递（而不是请求头）：
 * 中转层只转发白名单字段，前端无法用任意 header 操纵上游，
 * 因此可控故障也必须走同一条被允许的路径 —— 这本身就是一条断言。
 *
 *   metadata.mock = {
 *     fail:   'network' | 500 | 429 | 'reject400' | 'errorframe' | 'idle'
 *             'abort'（发够 tokens 个增量后不发 message_stop 直接关连接）
 *     tokens:  增量个数（默认 12）
 *     gap:     每个增量间隔 ms（默认 15）
 *   }
 *
 *   X-Mock-Key-Check:1  —— 这个头是 mock 自己读的（不经中转），用于验证 Key 确实送达上游
 *
 * 观察：GET /__calls 返回每次收到的请求（含 Authorization），
 *       GET /__reset 清空。冒烟脚本据此断言「上游只被打了一次」。
 */
const http = require('node:http');

const PORT = Number(process.argv[2] || 8787);
const calls = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    res.writeHead(req.headers.authorization ? 200 : 401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }));
  }

  // 账户余额：仅检查 Key，返回与 DeepSeek 同形的余额结构
  if (req.method === 'GET' && req.url === '/user/balance') {
    if (!req.headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '110.00',
        granted_balance: '10.00',
        topped_up_balance: '100.00',
      }],
    }));
  }

  if (req.method === 'GET' && req.url === '/__calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ calls }));
  }

  if (req.method === 'POST' && req.url === '/__reset') {
    calls.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Files API：只校验 Key 和 multipart 能到达，返回可用的假 file_id
  if (req.method === 'POST' && req.url === '/anthropic/v1/files') {
    const raw = await readRaw(req);
    if (!req.headers['x-api-key'] && !req.headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }
    if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'expected multipart/form-data' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'file-mock-' + require('node:crypto').randomBytes(6).toString('hex'),
      type: 'file',
      size_bytes: raw.length,
      created_at: new Date().toISOString(),
      filename: 'mock-upload.bin',
      mime_type: 'application/octet-stream',
    }));
  }

  if (req.method === 'DELETE' && req.url.startsWith('/anthropic/v1/files/')) {
    if (!req.headers['x-api-key'] && !req.headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && req.url === '/v1/tools/asr') {
    await readRaw(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ text: 'mock transcript' }));
  }

  if (req.method === 'POST' && req.url === '/v1/tools/tts') {
    await readRaw(req);
    // 100ms 24kHz 单声道 16-bit 静音
    res.writeHead(200, { 'content-type': 'audio/pcm' });
    return res.end(Buffer.alloc(24000 * 2 / 10));
  }

  if (req.method === 'POST' && req.url === '/anthropic/v1/messages') {
    const body = await readBody(req);
    const auth = req.headers.authorization || '';
    const mock = (body.metadata && body.metadata.mock) || {};
    const fail = String(mock.fail || '');
    calls.push({
      at: Date.now(),
      hasAuth: Boolean(auth),
      authPrefix: auth ? auth.slice(0, 7) : '',
      model: body.model,
      stream: body.stream,
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      title: Boolean(body.title && body.title.enabled),
      safety: body.safety_check ? body.safety_check.level : null,
      fail,
    });

    if (req.headers['x-mock-key-check'] === '1' && !auth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }

    if (fail === 'network') { req.socket.destroy(); return; }
    if (fail === 'reject400' || fail === '400') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'mock 400' } }));
    }
    if (fail === '429' || fail === '500' || fail === '503') {
      const status = Number(fail);
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: `mock ${status}` } }));
    }

    const tokens = Math.max(1, Number(mock.tokens || process.env.MOCK_TOKENS || 12));
    const gap = Math.max(0, Number(mock.gap || process.env.MOCK_GAP || 15));
    const msgId = 'mock_' + require('node:crypto').randomBytes(6).toString('hex');

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      sse(res, 'message_start', JSON.stringify({
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: body.model || 'mock-model', content: [], usage: { input_tokens: 8, output_tokens: 0 } },
      }));
      sse(res, 'content_block_start', JSON.stringify({
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      }));
      sse(res, 'ping', JSON.stringify({ type: 'ping' }));

      if (fail === 'idle') {
        sse(res, 'content_block_delta', JSON.stringify({
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'H' },
        }));
        return; // 永久静默：由中继的 idle 超时判死（连接不结束）
      }

      if (fail === 'errorframe') {
        sse(res, 'error', JSON.stringify({
          type: 'error', error: { type: 'overloaded_error', message: 'mock overloaded' },
        }));
        return res.end();
      }

      for (let i = 0; i < tokens; i++) {
        sse(res, 'content_block_delta', JSON.stringify({
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `tok${i} ` },
        }));
        if (fail === 'abort' && i + 1 >= tokens) return res.end(); // 不发 message_stop 就断
        await sleep(gap);
      }
      sse(res, 'content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 }));
      sse(res, 'message_delta', JSON.stringify({
        type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: tokens },
      }));
      sse(res, 'message_stop', JSON.stringify({ type: 'message_stop' }));
      res.end();
    } catch { /* 客户端已断开 */ }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-upstream 已启动  http://127.0.0.1:${PORT}`);
  console.log('  POST /anthropic/v1/messages   GET /models');
  console.log('  GET /__calls（观察上游收到什么）  POST /__reset（清空）');
});

const shutdown = () => { server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
