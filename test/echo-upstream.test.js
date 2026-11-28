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

/** 解析出全部 SSE 事件对象（Anthropic 与 OpenAI 两种形状都覆盖） */
function events(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6);
    if (raw === '[DONE]') continue;
    try { out.push(JSON.parse(raw)); } catch { /* 非 JSON */ }
  }
  return out;
}

/** content_block_start 出现的内容块类型序列（Anthropic） */
function blockTypes(text) {
  return events(text)
    .filter((o) => o.type === 'content_block_start')
    .map((o) => o.content_block.type + (o.content_block.name ? '/' + o.content_block.name : ''));
}

/** 某类增量事件的文本拼接（thinking_delta / signature_delta 等） */
function deltaText(text, type) {
  return events(text)
    .filter((o) => o.type === 'content_block_delta' && o.delta && o.delta.type === type)
    .map((o) => o.delta[type === 'text_delta' ? 'text' : type === 'thinking_delta' ? 'thinking' : 'signature'] || '')
    .join('');
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

// ------------------------------------------------------ 回复表 / 随机回复

test('E-13 回复表：/mode random 从表里选一条，/reply 可指定条目', async () => {
  const list = JSON.parse((await get('/__replies')).text);
  assert.ok(list.count >= 8, `回复表应有若干条，实得 ${list.count}`);

  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/mode random\n随便来一条' }],
  });
  const joined = deltas(res.text).join('');
  assert.match(joined, /回复表 r\d+/, '应标明来自哪一条：' + joined.slice(0, 60));
  const hit = list.replies.find((r) => joined.includes(`回复表 ${r.id}`));
  assert.ok(hit, '选中的 id 必须在表内');
  const full = list.replies.find((r) => r.id === 'r04');
  assert.ok(full, '默认表应含 r04');

  const one = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/mode random\n/reply r04\n随便来一条' }],
  });
  assert.ok(deltas(one.text).join('').includes('方案'), 'r04 应命中表格内容：' + deltas(one.text).join('').slice(0, 60));
});

test('E-14 /seed 固定随机序列；POST /__replies 可换表', async () => {
  const call = () => post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/mode random\n/seed 7\n随机但可复现' }],
  });
  const a = deltas((await call()).text).join('');
  const b = deltas((await call()).text).join('');
  assert.strictEqual((/回复表 (r\d+)/.exec(a) || [])[1], (/回复表 (r\d+)/.exec(b) || [])[1], '同 seed 应选同一条');

  await post('/__replies', { replies: [{ id: 'z1', topic: '演示', text: '自定义回复表的内容甲' }, { id: 'z2', topic: '演示', text: '自定义回复表的内容乙' }] });
  const c = deltas((await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/mode random\n/reply z2' }],
  })).text).join('');
  assert.ok(c.includes('内容乙'), '换表后应按新表命中：' + c.slice(0, 80));
  const reset = JSON.parse((await post('/__replies', { reset: true })).text);
  assert.ok(reset.count >= 8, 'reset 应还原默认表');
});

// ------------------------------------------------------------ 思考与联网

test('E-15 /think：思考块完整（thinking_delta + signature_delta），正文不受影响', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/think\n思考一下这个问题' }],
  });
  assert.ok(blockTypes(res.text).includes('thinking'), JSON.stringify(blockTypes(res.text)));
  const thinking = deltaText(res.text, 'thinking_delta');
  assert.ok(thinking.length > 10, '思考内容过短：' + thinking);
  assert.ok(deltaText(res.text, 'signature_delta'), '思考块应有 signature_delta');
  assert.ok(deltas(res.text).join('').includes('思考一下这个问题'), '正文仍应复读');
  assert.match(res.text, /event: message_stop/);
});

test('E-16 /search：联网搜索两块（调用 + 结果）+ 正文引用，usage 带 server_tool_use', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/search 3\n帮我查一下最新情况' }],
  });
  const types = blockTypes(res.text);
  assert.ok(types.includes('server_tool_use/deepseek_web_search'), JSON.stringify(types));
  assert.ok(types.includes('web_search_tool_result'), JSON.stringify(types));
  const results = events(res.text)
    .find((o) => o.type === 'content_block_start' && o.content_block.type === 'web_search_tool_result').content_block.content;
  assert.strictEqual(results.length, 3, '应返回 3 条结果');
  for (const r of results) {
    assert.match(r.url, /^https?:\/\//);
    assert.strictEqual(typeof r.title, 'string');
    assert.strictEqual(typeof r.snippet, 'string');
  }
  const cites = events(res.text).filter((o) => o.delta && o.delta.type === 'citations_delta');
  assert.strictEqual(cites.length, 3, '每条结果应各有一次 citations_delta');
  const md = events(res.text).find((o) => o.type === 'message_delta');
  assert.ok(md.usage.input_tokens >= 0 && typeof md.usage.cache_read_input_tokens === 'number', 'usage 四字段齐全');
  assert.ok(md.usage.server_tool_use && md.usage.server_tool_use.web_search_requests === 1, JSON.stringify(md.usage));
});

test('E-17 跟随请求开关：thinking.enabled / tools 声明即出对应块（无需命令行）', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    thinking: { type: 'enabled' },
    tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }, { type: 'deepseek_web_search', name: 'deepseek_web_search' }],
    messages: [{ role: 'user', content: '开关驱动' }],
  });
  const types = blockTypes(res.text);
  assert.ok(types.includes('thinking'), JSON.stringify(types));
  assert.ok(types.includes('server_tool_use/deepseek_web_search'), JSON.stringify(types));

  // 只声明 read_url 且正文没有链接 → 不出联网块，仍是纯复读
  const plain = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    thinking: { type: 'disabled' },
    tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
    messages: [{ role: 'user', content: '没有链接也没有开关' }],
  });
  assert.deepStrictEqual(blockTypes(plain.text), ['text'], JSON.stringify(blockTypes(plain.text)));
  assert.ok(deltas(plain.text).join('').includes('没有链接也没有开关'));
});

test('E-18 正文带链接 + 声明 deepseek_read_url → 出 read_link 与 web_fetch_tool_result', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
    messages: [{ role: 'user', content: '读一下 https://docs.example.org/api/create-message 讲什么' }],
  });
  const types = blockTypes(res.text);
  assert.ok(types.includes('server_tool_use/deepseek_read_url'), JSON.stringify(types));
  const fetch = events(res.text).find((o) => o.content_block && o.content_block.type === 'web_fetch_tool_result');
  assert.ok(fetch, JSON.stringify(types));
  assert.strictEqual(fetch.content_block.kind, 'read_link');
  assert.ok(fetch.content_block.signature, 'read_link 结果应带 signature（多轮回传用）');
  assert.strictEqual(fetch.content_block.content.type, 'web_fetch_result');
});

// ---------------------------------------------------------- 智能体演示

test('E-19 任务 1：完整「思考 → 搜索 → 引用 → 报告」事件序列 + 自动标题', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/agent 1\n深圳今天天气和出行建议' }],
  });
  const types = blockTypes(res.text);
  assert.deepStrictEqual(types, [
    'thinking', 'server_tool_use/deepseek_web_search', 'web_search_tool_result', 'text',
  ], JSON.stringify(types));
  assert.ok(deltas(res.text).join('').includes('深圳今天天气和出行建议'), '报告应围绕用户问题');
  const md = events(res.text).find((o) => o.type === 'message_delta');
  assert.strictEqual(md.delta.stop_reason, 'end_turn');
  assert.ok(md.delta.title, '任务应产出会话标题');
  assert.match(res.text, /event: message_stop/);

  // 工作流轨迹可观测
  const wf = JSON.parse((await get('/__workflow')).text);
  const run = wf.runs.find((r) => r.agent && r.agent.id === 1);
  assert.ok(run && run.timeline.length === 4, JSON.stringify(run && run.timeline));
});

test('E-20 任务 2：阅读链接 + 附件引用出现在结论里', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: [
      { type: 'file', file_id: 'file-demo-1' },
      { type: 'text', text: '/agent 2\n结合这个文件读 https://weather.example.org/shenzhen/today' },
    ] }],
  });
  const types = blockTypes(res.text);
  assert.ok(types.includes('server_tool_use/deepseek_read_url'), JSON.stringify(types));
  const joined = deltas(res.text).join('');
  assert.ok(joined.includes('file-demo-1'), '附件 file_id 应进入总结：' + joined.slice(0, 120));
  assert.ok(/链接内容摘要/.test(joined));
});

test('E-21 任务 3：第 1 轮 tool_use 收尾，回传 tool_result 后第 2 轮正常汇总', async () => {
  const first = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '/agent 3\n分析近 7 天订单异常' }],
  });
  const types = blockTypes(first.text);
  assert.ok(types.some((t) => t.startsWith('tool_use')), JSON.stringify(types));
  const md1 = events(first.text).find((o) => o.type === 'message_delta');
  assert.strictEqual(md1.delta.stop_reason, 'tool_use', '第 1 轮必须以 tool_use 结束');

  const second = await post('/anthropic/v1/messages', {
    model: 'm', stream: true,
    messages: [
      { role: 'user', content: '/agent 3\n分析近 7 天订单异常' },
      { role: 'assistant', content: [
        { type: 'text', text: '我先调用工具' },
        { type: 'tool_use', id: 'toolu_1', name: 'query_orders', input: { range: '7d' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[{"id":101,"abnormal":true}]' }] },
    ],
  });
  const md2 = events(second.text).find((o) => o.type === 'message_delta');
  assert.strictEqual(md2.delta.stop_reason, 'end_turn');
  assert.ok(deltas(second.text).join('').includes('执行结果汇总'), deltas(second.text).join('').slice(0, 120));
  assert.match(second.text, /event: message_stop/);
});

test('E-22 智能体演示的其余入口与边界：query / metadata / 未知任务 / 半截收场', async () => {
  const byQuery = await post('/anthropic/v1/messages?agent=1', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '用 query 触发演示' }],
  });
  assert.ok(blockTypes(byQuery.text).includes('server_tool_use/deepseek_web_search'), JSON.stringify(blockTypes(byQuery.text)));

  const byMeta = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, metadata: { mock: { agent: 2 } },
    messages: [{ role: 'user', content: '用 metadata 触发演示' }],
  });
  assert.ok(blockTypes(byMeta.text).some((t) => t.startsWith('server_tool_use/deepseek_read_url')), JSON.stringify(blockTypes(byMeta.text)));

  const bad = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/agent 9' }],
  });
  assert.strictEqual(bad.status, 400, bad.text.slice(0, 120));

  const cut = await post('/anthropic/v1/messages', {
    model: 'm', stream: true, messages: [{ role: 'user', content: '/agent 1\n/stopat 3\n演示中断' }],
  });
  assert.ok(!/event: message_stop/.test(cut.text), 'stopAt 之后不得出现 message_stop');

  const tasks = JSON.parse((await get('/agent/tasks')).text);
  assert.strictEqual(tasks.tasks.length, 3, '预置任务应为 3 个');
  assert.ok(tasks.tasks.every((t) => t.name && t.workflow.length), '每个任务都应有名称与工作流说明');
});

test('E-23 非流式的智能体演示：content 里按顺序给出各类块', async () => {
  const res = await post('/anthropic/v1/messages', {
    model: 'm', stream: false,
    messages: [{ role: 'user', content: '/agent 1\n非流式演示' }],
  });
  const o = JSON.parse(res.text);
  assert.deepStrictEqual(o.content.map((b) => b.type + (b.name ? '/' + b.name : '')), [
    'thinking', 'server_tool_use/deepseek_web_search', 'web_search_tool_result', 'text',
  ], JSON.stringify(o.content.map((b) => b.type)));
  assert.ok(o.content[0].signature, '非流式思考块也应带 signature');
  assert.ok(o.content[3].citations.length >= 1, '非流式正文应带引用');
  assert.strictEqual(o.stop_reason, 'end_turn');
});

test('E-24 OpenAI 形状同样支持思考 / 联网 / 演示', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'echo', stream: true,
    messages: [{ role: 'user', content: '/think\n/search 2\nOpenAI 形态演示' }],
  });
  const ev = events(res.text);
  assert.ok(ev.some((o) => o.choices && o.choices[0].delta.reasoning_content), '应有 reasoning_content 增量');
  assert.ok(ev.some((o) => o.choices && o.choices[0].delta.tool_calls), '应有 tool_calls 增量');
  assert.ok(ev.some((o) => o.choices && o.choices[0].delta.references), '应有 references（搜索结果）');
  const openAiBody = deltas(res.text).join('');
  assert.ok(openAiBody.includes('OpenAI 形态演示'), `正文仍应复读：${openAiBody.slice(0, 120)}`);
  assert.strictEqual(ev.at(-1).choices[0].finish_reason, 'stop');
  assert.match(res.text, /data: \[DONE\]/);
});

