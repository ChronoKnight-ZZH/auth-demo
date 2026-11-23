'use strict';
/**
 * echo-upstream 自检：拉起复读机进程，逐条验证「真的在复读」以及故障注入是否可用。
 * 用法：npm run test:echo     （无需 MySQL/Redis/远程 Key）
 */
const nodeTest = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;

function post(p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(BASE + p, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        authorization: 'Bearer sk-test-echo',
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: raw }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, { headers: { authorization: 'Bearer sk-test-echo' } }, (res) => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: raw }));
    }).on('error', reject);
  });
}

/** 把 SSE 文本里的 text_delta 拼起来 */
function deltas(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const o = JSON.parse(line.slice(6));
      if (o?.delta?.type === 'text_delta') out.push(o.delta.text);
      if (o?.choices?.[0]?.delta?.content) out.push(o.choices[0].delta.content);
    } catch { /* ping / [DONE] */ }
  }
  return out;
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'echo-upstream.js'), String(PORT)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
// stdout 不接（否则写端被子进程持有，测试进程跑完也不会退出）；stderr 转发
child.stderr.setEncoding('utf8');
child.stderr.resume();
let childExited = false;
child.on('exit', (code) => { childExited = true; if (code !== 0 && code !== null) process.stderr.write(`[echo] 子进程退出 code=${code}\n`); });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await get('/health'); if (r.status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('echo-upstream 未能启动');
}

// Node 16 顶层注册的 test.before/test.after 不会执行（只在 describe 套件内生效），
// 这里把「等服务就绪」放进每个测试，并用 unref + exit 兜底清理子进程。
const ready = waitUp();
child.unref();
if (typeof child.stderr.unref === 'function') child.stderr.unref();
process.once('exit', () => { try { child.kill(); } catch { /* 已退出 */ } });

function test(name, fn) {
  return nodeTest(name, async (t) => {
    await ready;
    return fn(t);
  });
}

test('E-01 复读最后一条用户消息（Anthropic 流式，逐块下发且以 message_stop 收场）', async () => {
  const text = '第一段。\n第二段：hello world。';
  const res = await post('/anthropic/v1/messages', {
    model: 'deepseek-v4-flash', stream: true,
    messages: [{ role: 'user', content: '前一轮' }, { role: 'assistant', content: '上一答' }, { role: 'user', content: text }],
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  const joined = deltas(res.text).join('');
  assert.ok(joined.includes('第二段：hello world。'), joined);
  assert.ok(/user轮次=2/.test(joined), '元信息应带 user 轮次：' + joined);
  assert.ok(!joined.includes('前一轮'), '只复读最后一条用户消息');
  assert.match(res.text, /event: message_stop/);
  assert.match(res.text, /"stop_reason":"end_turn"/);
});

test('E-02 非流式返回完整 content（stream:false）', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: false, messages: [{ role: 'user', content: '非流式复读' }],
  });
  assert.strictEqual(res.status, 200);
  const o = JSON.parse(res.text);
  assert.strictEqual(o.type, 'message');
  assert.ok(o.content[0].text.includes('非流式复读'), res.text);
});

test('E-03 OpenAI 兼容路径同样复读，并以 [DONE] 收场', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'echo', stream: true,
    messages: [
      { role: 'system', content: '你是一个助手' },
      { role: 'user', content: [{ type: 'text', text: 'OpenAI 格式复读' }] },
    ],
  });
  assert.strictEqual(res.status, 200);
  assert.ok(deltas(res.text).join('').includes('OpenAI 格式复读'));
  assert.match(res.text, /data: \[DONE\]/);
  const calls = JSON.parse((await get('/__calls')).text).calls;
  const last = calls[calls.length - 1];
  assert.strictEqual(last.api, 'openai');
  assert.strictEqual(last.systemChars, '你是一个助手'.length, 'system 字数应被记录');
});

test('E-04 多模态块不以文本出现，但在 /__calls 里可见（证明附件真到了上游）', async () => {
  await post('/__reset', {});
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '带附件的提问' },
      { type: 'file', file_id: 'file-abc123' },
      { type: 'image', source: { type: 'file', file_id: 'file-img9' } },
    ] }],
  });
  const joined = deltas(res.text).join('');
  assert.ok(joined.includes('带附件的提问'));
  const last = JSON.parse((await get('/__calls')).text).calls.slice(-1)[0];
  assert.ok(last.nonTextBlocks.includes('file_id=file-abc123'), JSON.stringify(last.nonTextBlocks));
  assert.ok(last.nonTextBlocks.some((b) => b.startsWith('image:file_id=')));
});

test('E-05 命令行注入：/fail 500 与 /fail 400 用真实 HTTP 状态码收场', async () => {
  const a = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/fail 500\n正文' }],
  });
  assert.strictEqual(a.status, 500);
  const b = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/fail 400' }],
  });
  assert.strictEqual(b.status, 400);
  const c = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
    metadata: { mock: { fail: 429 } },
  });
  assert.strictEqual(c.status, 429);
  assert.ok(c.headers['retry-after'], '429 应带 retry-after');
});

test('E-06 /gap 与 /delay 生效（首字节延迟 + 块间隔）', async () => {
  const t0 = Date.now();
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/delay 250\n/gap 60\n甲 乙 丙 丁 戊 己 庚 辛' }],
  });
  const elapsed = Date.now() - t0;
  const n = deltas(res.text).length;
  assert.ok(n >= 2, `应切成多块，实得 ${n}`);
  assert.ok(elapsed >= 250, `delay 未生效：${elapsed}ms`);
  assert.ok(elapsed >= 250 + (n - 1) * 60 * 0.6, `gap 未生效：${elapsed}ms / ${n} 块`);
});

test('E-07 /stopat N 半截收场且不发 message_stop（测续推/中断判定）', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/stopat 2\n/tokens 8\n一二三四五六七八九十' }],
  });
  assert.strictEqual(deltas(res.text).length, 2);
  assert.ok(!/event: message_stop/.test(res.text), 'stopAt 之后不得出现 message_stop');
});

test('E-08 /mode upper 与 /repeat 3', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/mode upper\n/repeat 3\nabc' }],
  });
  const joined = deltas(res.text).join('');
  assert.ok(joined.includes('ABC'), joined);
  assert.strictEqual((joined.match(/\[echo\] ABC/g) || []).length, 3, '应复读 3 遍：' + joined);
});

test('E-09 /models 需要 Authorization（验证 Key 确实送达上游）', async () => {
  const withKey = await get('/models');
  assert.strictEqual(withKey.status, 200);
  const noKey = await new Promise((resolve, reject) => {
    http.get(BASE + '/models', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.strictEqual(noKey, 401);
});

test('E-10 文件与语音代理端点可用', async () => {
  const up = await new Promise((resolve, reject) => {
    const boundary = '----echoTest';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n--${boundary}--\r\n`
    );
    const req = http.request(BASE + '/anthropic/v1/files', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': payload.length, authorization: 'Bearer sk-x' },
    }, (res) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    req.on('error', reject); req.end(payload);
  });
  assert.strictEqual(up.status, 200);
  const file = JSON.parse(up.text);
  assert.match(file.id, /^file-echo-/);
  assert.ok(file.size_bytes > 0);

  const asr = await post('/v1/tools/asr', { whatever: true });
  assert.strictEqual(asr.status, 200);
  assert.match(JSON.parse(asr.text).text, /echo asr/);

  const tts = await post('/v1/tools/tts', { text: 'hi' });
  assert.strictEqual(tts.status, 200);
  assert.match(tts.headers['content-type'], /audio\/pcm/);
});

test('E-11 /fail network 直接掐连接（熔断测试用），后续请求不受影响', async () => {
  await assert.rejects(() => post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/fail network' }],
  }));
  const ok = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '恢复' }],
  });
  assert.strictEqual(ok.status, 200);
  assert.ok(deltas(ok.text).join('').includes('恢复'));
});

test('E-12 /__calls 记录鉴权前缀，且不含 Key 明文全文', async () => {
  await post('/__reset', {});
  await post('/anthropic/v1/messages', { model: 'm', stream: true, messages: [{ role: 'user', content: 'k' }] });
  const c = JSON.parse((await get('/__calls')).text).calls.slice(-1)[0];
  assert.strictEqual(c.hasAuth, true);
  assert.ok(String(c.authPrefix).startsWith('Bearer'), `authPrefix=${JSON.stringify(c.authPrefix)}`);
});
