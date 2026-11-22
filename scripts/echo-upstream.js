'use strict';
/**
 * 本地复读机上游（测试 API）。
 *
 * 与 mock-upstream 的区别：mock-upstream 吐固定的 `tok0 tok1 …`，
 * 只能验证「链路通不通」；本脚本【原样复读】你发过去的最后一条用户消息，
 * 因此可以肉眼确认「附件/多轮/system/参数到底有没有真的送到上游」，
 * 同时把整条 SSE 链路（断点续推、心跳、停止、熔断）跑在零成本、零网络的环境里。
 *
 * 用法
 *   node scripts/echo-upstream.js [port]        默认 8788
 *   npm run mock:echo                            同上
 * 然后 .env 里指向它（业务代码零改动，换回远程只改这一行）：
 *   UPSTREAM_BASE_URL=http://127.0.0.1:8788
 *   UPSTREAM_API_KEY=sk-echo-any-non-empty-value
 *
 * 兼容的上游端点（与 src/config.js 的 upstream 路径一一对应）：
 *   POST /anthropic/v1/messages     流式 + 非流式，按 body.stream 决定
 *   POST /v1/chat/completions       OpenAI 格式（同一套复读逻辑，方便直接 curl 前端/其他工具）
 *   GET  /models                    带 Authorization 才 200（验证 Key 确实送达）
 *   POST /anthropic/v1/files        返回假 file_id，并记录字节数
 *   DELETE /anthropic/v1/files/:id
 *   POST /v1/tools/asr              { text: '<复读>' }
 *   POST /v1/tools/tts              真 PCM 静音流（分块下发，可测流式音频）
 *   GET  /                          自带一个极简网页测试台（不需要登录，直连本服务）
 *   GET  /__calls  POST /__reset    观察上游到底收到什么 / 清空
 *
 * 故障与行为控制（三种等价入口，优先级：请求行内命令 > metadata.mock > query > 环境变量）：
 *   metadata.mock = { fail, gap, tokens, delay, stopAt, repeat, mode, stop }
 *   ?fail=500&gap=200&delay=3000    （直连 curl 时最方便）
 *   消息正文首行 `/fail 500`、`/gap 200`、`/delay 3s`、`/repeat 3`、
 *   `/mode upper`、`/stop max_tokens`、`/stopat 5`、`/echo <正文>`
 *   —— 在聊天框里打一行命令就能让上游抽风，不用改任何代码或配置。
 *
 *   fail   : 'network'（直接掐 socket）| 400|429|500|503 | 'errorframe' | 'idle'
 *            | 'abort'（发够 stopAt/tokens 帧后不发 message_stop 就关连接）
 *   gap    : 每个增量之间的间隔 ms（默认 30）
 *   delay  : 首字节延迟 ms（测 headers 超时 / 前端 loading）
 *   tokens : 强制增量个数（0 = 按正文自然切分）
 *   stopAt : 只发前 N 个增量后收场（测半截续推）
 *   repeat : 把复读内容重复 N 遍（测长回复、缓冲截断）
 *   mode   : 'echo'（默认，原样复读）| 'upper' | 'reverse' | 'count'（只报字数）| 'slow'
 *   stop   : stop_reason，默认 end_turn
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || process.env.ECHO_PORT || 8788);
const HOST = process.env.ECHO_HOST || '127.0.0.1';
/** 默认在复读前加这一句，方便一眼看出「这轮打到本地了，没花钱」 */
const PREFIX = process.env.ECHO_PREFIX === undefined ? '[echo] ' : process.env.ECHO_PREFIX;

const calls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 工具

function readBody(req, { limit = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function json(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 秒/毫秒都收：'3s' → 3000，'500' / 500 → 500 */
function parseMs(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : Math.round(n);
}

// ------------------------------------------------------- 消息提取与复读

/** 把 Anthropic / OpenAI 的 content 归一成纯文本（并统计非文本块，用来证明附件确实到了上游） */
function flattenContent(content) {
  const texts = [];
  const parts = [];
  if (typeof content === 'string') { texts.push(content); return { text: content, parts }; }
  if (!Array.isArray(content)) return { text: '', parts };
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      parts.push(`text(${block.text.length})`);
    } else if (block.type === 'input_audio' || block.type === 'audio') {
      parts.push('audio');
    } else if (block.type === 'image') {
      const src = block.source || {};
      parts.push(src.type === 'file' ? `image:file_id=${src.file_id || '?'}` : `image:${src.media_type || 'base64'}`);
    } else if (block.type === 'file') {
      parts.push(`file_id=${block.file_id || '?'}`);
    } else if (block.type === 'tool_use') {
      parts.push(`tool_use:${block.name || '?'}`);
    } else if (block.type === 'tool_result') {
      parts.push('tool_result');
    } else if (block.type === 'thinking') {
      parts.push('thinking');
    } else {
      parts.push(block.type || 'unknown');
    }
  }
  return { text: texts.join('\n'), parts };
}

/** 归一成 { lastUser, history } —— system 单独取（Anthropic 顶层 / OpenAI 首条 system） */
function extractRequest(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const norm = msgs.map((m) => {
    const flat = flattenContent(m.content);
    return { role: String(m.role || '?'), ...flat };
  });
  let lastUser = '';
  for (let i = norm.length - 1; i >= 0; i--) {
    if (norm[i].role === 'user') { lastUser = norm[i].text; break; }
  }
  const sysFlat = flattenContent(body.system);
  const openAiSystem = norm.find((m) => m.role === 'system');
  const system = sysFlat.text || (openAiSystem ? openAiSystem.text : '');
  const nonText = norm.filter((m) => m.parts.length).flatMap((m) => m.parts).filter((p) => !p.startsWith('text('));
  return {
    system,
    lastUser,
    round: norm.filter((m) => m.role === 'user').length,
    history: norm.map((m) => ({ role: m.role, len: m.text.length, blocks: m.parts })),
    nonText,
  };
}

/**
 * 正文里的控制命令。首行以 `/` 开头即视为命令，剩余行才是真正要复读的内容。
 * 支持多条命令（连续多行都以 / 开头）。
 */
function parseCommands(text) {
  const opts = {};
  if (typeof text !== 'string' || !text.startsWith('/')) return { text, opts };
  const lines = text.split('\n');
  const rest = [];
  for (const line of lines) {
    const m = /^\/([a-zA-Z]+)\s*(.*)$/.exec(line.trim());
    if (!rest.length && m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'fail') opts.fail = val;
      else if (key === 'gap') opts.gap = Math.max(0, Number(val) || 0);
      else if (key === 'tokens') opts.tokens = Math.max(0, Number(val) || 0);
      else if (key === 'repeat') opts.repeat = Math.max(1, Number(val) || 1);
      else if (key === 'stopat') opts.stopAt = Math.max(1, Number(val) || 0);
      else if (key === 'delay') opts.delay = parseMs(val);
      else if (key === 'mode') opts.mode = val;
      else if (key === 'stop') opts.stop = val;
      else if (key === 'echo') { rest.push(line.replace(/^\s*\/echo\s*/, '')); continue; }
      continue; // 未知命令：吞掉但不影响复读
    }
    rest.push(line);
  }
  return { text: rest.join('\n').replace(/^\n+/, ''), opts };
}

function applyMode(text, mode) {
  switch (mode) {
    case 'upper': return text.toUpperCase();
    case 'reverse': return [...text].reverse().join('');
    case 'count': return `${[...text].length} 字符 / ${text.split(/\s+/).filter(Boolean).length} 词`;
    default: return text;
  }
}

/** 组装复读正文：先给一行「收到什么」的元信息，再原样复读 */
function buildReply(req0, extracted, opts) {
  const applied = applyMode(req0, opts.mode || process.env.ECHO_MODE || 'echo');
  const bodyLine = `${PREFIX}${applied}`;
  const meta = [];
  meta.push(`model=${opts.model}`);
  meta.push(`stream=${opts.stream ? 'true' : 'false'}`);
  meta.push(`user轮次=${extracted.round}`);
  if (extracted.system) meta.push(`system=${extracted.system.length}字`);
  if (extracted.nonText.length) meta.push(`非文本块=${extracted.nonText.join(',')}`);
  const lines = [bodyLine, '', `> ${meta.join(' · ')}`];
  for (let i = 1; i < opts.repeat; i++) lines.push('', bodyLine);
  return lines.join('\n');
}

/**
 * 切成适合流式下发的块：优先按词（Intl.Segmenter 支持中文），
 * 拿不到就退化成「空白分隔 + 定长切片」。
 */
function chunkText(text, maxPieces = 3) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(text), (s) => s.segment)
    : text.split(/(\s+)/).filter((s) => s !== '');
  const out = [];
  for (let i = 0; i < seg.length; i += maxPieces) out.push(seg.slice(i, i + maxPieces).join(''));
  return out.length ? out : [text];
}

/** 强制 N 个增量时，把正文按块数均分（不够就循环填充，多出来的一律并入最后一块） */
function forceChunks(text, n) {
  const base = chunkText(text);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i < base.length) out.push(base[i]);
    else if (i === n - 1) out.push('');
    else out.push(base[i % base.length]);
  }
  return out.filter((c, i) => c !== '' || i === n - 1);
}

// ------------------------------------------------------------------ 参数合并

function resolveOpts(body, url, extracted) {
  const cmd = parseCommands(extracted.lastUser);
  const q = url.searchParams;
  const meta = (body.metadata && body.metadata.mock) || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  const failRaw = pick(cmd.opts.fail, meta.fail, q.get('fail'), process.env.ECHO_FAIL);
  const gapRaw = pick(cmd.opts.gap, meta.gap, q.get('gap'), process.env.ECHO_GAP);
  const tokensRaw = pick(cmd.opts.tokens, meta.tokens, q.get('tokens'), process.env.ECHO_TOKENS);
  const delayRaw = pick(cmd.opts.delay, meta.delay, parseMs(q.get('delay') || ''), process.env.ECHO_DELAY);
  const stopAtRaw = pick(cmd.opts.stopAt, meta.stopAt, q.get('stopAt'));
  const repeatRaw = pick(cmd.opts.repeat, meta.repeat, q.get('repeat'));
  return {
    fail: failRaw === undefined ? '' : String(failRaw),
    gap: Math.max(0, Number(gapRaw !== undefined ? gapRaw : 30) || 0),
    tokens: Math.max(0, Number(tokensRaw) || 0),
    delay: delayRaw === undefined ? 0 : (parseMs(delayRaw) || 0),
    stopAt: Math.max(0, Number(stopAtRaw) || 0),
    repeat: Math.max(1, Number(repeatRaw) || 1),
    mode: String(pick(cmd.opts.mode, meta.mode, q.get('mode'), process.env.ECHO_MODE) || 'echo'),
    stop: String(pick(cmd.opts.stop, meta.stop, q.get('stop')) || 'end_turn'),
    model: String(body.model || 'echo-model'),
    stream: body.stream !== false,
    /** 命令行之后的正文才是复读对象 */
    text: cmd.text,
    mockKeys: Object.keys(meta).length ? Object.keys(meta).join(',') : null,
  };
}

// -------------------------------------------------------- 流式：Anthropic

async function streamAnthropic(res, { reply, chunks, opts, model }) {
  const msgId = 'echo_' + crypto.randomBytes(6).toString('hex');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  try {
    sseWrite(res, 'message_start', {
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null,
        usage: { input_tokens: Math.ceil(reply.length / 4), output_tokens: 0 },
      },
    });
    sseWrite(res, 'content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    });
    sseWrite(res, 'ping', { type: 'ping' });

    if (opts.fail === 'errorframe') {
      sseWrite(res, 'error', {
        type: 'error', error: { type: 'overloaded_error', message: 'echo injected error frame' },
      });
      return res.end();
    }

    // abort：发满 abortAt 块后【不发 message_stop】直接关连接 —— 中继必须判为中断而非完成
    const abortAt = opts.fail === 'abort' ? (opts.stopAt || chunks.length) : 0;
    let sent = 0;
    for (const c of chunks) {
      if (opts.stopAt && sent >= opts.stopAt) return res.end(); // 半截收场：不发终止帧（测断点续推）
      sseWrite(res, 'content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c },
      });
      sent += 1;
      if (abortAt && sent >= abortAt) return res.end();
      if (opts.fail === 'idle' && sent >= 1) return; // 永久静默：交给中继的 idle 超时判死
      if (opts.gap) await sleep(opts.gap);
    }
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sseWrite(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: opts.stop },
      usage: { output_tokens: sent },
    });
    sseWrite(res, 'message_stop', { type: 'message_stop' });
    res.end();
  } catch { /* 客户端已断开 */ }
}

// ---------------------------------------------------------- 流式：OpenAI

async function streamOpenAi(res, { chunks, opts, model }) {
  const id = 'chatcmpl-echo-' + crypto.randomBytes(5).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const send = (delta, finish) => {
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    })}\n\n`);
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
  });
  try {
    send({ role: 'assistant' });
    let n = 0;
    for (const c of chunks) {
      if (opts.stopAt && n >= opts.stopAt) break;
      send({ content: c });
      n += 1;
      if (opts.gap) await sleep(opts.gap);
    }
    send({}, opts.stop === 'max_tokens' ? 'length' : 'stop');
    res.end('data: [DONE]\n\n');
  } catch { /* 客户端已断开 */ }
}

// ------------------------------------------------------------------ 页面

const TEST_PAGE = `<!doctype html><meta charset="utf-8"><title>echo-upstream 测试台</title>
<style>
body{font:14px/1.6 ui-sans-serif,system-ui;margin:24px;max-width:820px;background:#0f1115;color:#e6e6e6}
textarea{width:100%;height:88px;background:#171a21;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:8px;padding:10px;font:inherit}
button{background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:12px;min-height:120px}
code{background:#171a21;padding:1px 5px;border-radius:4px}
.hint{color:#8b93a1}
</style>
<h2>本地复读机 · 直连上游测试台</h2>
<p class="hint">这个页面绕开后台登录，直接打本服务的 <code>/v1/chat/completions</code>，用来单独确认复读机本身工作正常。
正文首行可输入 <code>/fail 500</code> <code>/gap 300</code> <code>/delay 5s</code> <code>/mode upper</code> <code>/repeat 3</code> 等命令。</p>
<textarea id="t">你好，复读机！
这是第二轮。</textarea>
<p><button id="go">发送（流式）</button> <span id="s" class="hint"></span></p>
<pre id="o"></pre>
<script>
const $=id=>document.getElementById(id);
$('go').onclick=async()=>{
  $('o').textContent='';$('s').textContent='连接中…';
  const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'echo',stream:true,messages:[{role:'user',content:$('t').value}]})});
  if(!r.ok){$('s').textContent='HTTP '+r.status;$('o').textContent=await r.text();return;}
  $('s').textContent='流式中…';
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\\n');buf=lines.pop();
    for(const l of lines){const m=/^data: (.*)$/.exec(l.trim());if(!m||m[1]==='[DONE]')continue;
      try{const d=JSON.parse(m[1]).choices[0].delta.content;if(d){$('o').textContent+=d;}}catch(e){}}}
  $('s').textContent='完成';
};
</script>`;

// ------------------------------------------------------------------ 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const hasAuth = Boolean(req.headers.authorization || req.headers['x-api-key']);

  try {
    // ---- 观察 / 运维 ----
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(TEST_PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'echo-upstream', calls: calls.length });
    }
    if (req.method === 'GET' && url.pathname === '/__calls') {
      return json(res, 200, { calls });
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      calls.length = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      if (!hasAuth) return json(res, 401, { error: { message: 'missing api key' } });
      return json(res, 200, { data: [{ id: 'echo-model' }, { id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] });
    }

    // ---- 聊天（复读核心）----
    const isAnthropic = req.method === 'POST' && url.pathname === '/anthropic/v1/messages';
    const isOpenAi = req.method === 'POST' && url.pathname === '/v1/chat/completions';
    if (isAnthropic || isOpenAi) {
      const body = await readJson(req);
      const extracted = extractRequest(body);
      const opts = resolveOpts(body, url, extracted);
      const reply = buildReply(opts.text || '(空消息)', extracted, opts);
      const chunks = opts.tokens > 0 ? forceChunks(reply, opts.tokens) : chunkText(reply);

      calls.push({
        at: Date.now(),
        api: isAnthropic ? 'anthropic' : 'openai',
        hasAuth,
        authPrefix: hasAuth ? String(req.headers.authorization || '').slice(0, 7) : '',
        model: body.model,
        stream: opts.stream,
        round: extracted.round,
        userChars: [...(extracted.lastUser || '')].length,
        userPreview: String(extracted.lastUser || '').slice(0, 120),
        systemChars: extracted.system.length,
        nonTextBlocks: extracted.nonText,
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        forwardedMock: opts.mockKeys,
        fail: opts.fail,
        chunks: chunks.length,
      });

      // 故障注入：首字节之前的失败，用真实 HTTP 状态码收场（中继据此走 502/503/504/429）
      if (opts.fail === 'network') { req.socket.destroy(); return; }
      if (opts.fail === '400' || opts.fail === 'reject400') {
        return json(res, 400, { error: { type: 'invalid_request_error', message: 'echo 400' } });
      }
      if (/^(401|403|408|413|429|500|502|503|504)$/.test(opts.fail)) {
        const st = Number(opts.fail);
        res.writeHead(st, {
          'content-type': 'application/json; charset=utf-8',
          ...(st === 429 ? { 'retry-after': '1' } : {}),
        });
        return res.end(JSON.stringify({ error: { type: st === 429 ? 'rate_limit_error' : 'api_error', message: `echo ${st}` } }));
      }

      if (opts.delay) {
        // 首字节延迟：测 UPSTREAM_HEADERS_TIMEOUT_MS 与前端 loading 观感。
        // 注意不要用 req.on('close')/req.destroyed 判断客户端离开 —— body 读完后
        // IncomingMessage 就会 close，那是正常路径；只有响应端 destroyed 才是真断连。
        const t0 = Date.now();
        await sleep(opts.delay);
        if (res.destroyed || res.writableEnded) return;
      }

      if (!opts.stream) {
        if (isAnthropic) {
          return json(res, 200, {
            id: 'echo_' + crypto.randomBytes(6).toString('hex'),
            type: 'message', role: 'assistant', model: opts.model,
            content: [{ type: 'text', text: reply }],
            stop_reason: opts.stop,
            usage: { input_tokens: Math.ceil(reply.length / 4), output_tokens: Math.ceil(reply.length / 4) },
          });
        }
        return json(res, 200, {
          id: 'chatcmpl-echo-' + crypto.randomBytes(5).toString('hex'),
          object: 'chat.completion', model: opts.model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: opts.stop }],
          usage: { prompt_tokens: 1, completion_tokens: Math.ceil(reply.length / 4), total_tokens: 1 },
        });
      }

      return isAnthropic
        ? streamAnthropic(res, { reply, chunks, opts, model: opts.model })
        : streamOpenAi(res, { chunks, opts, model: opts.model });
    }

    // ---- 文件 / 语音：与 mock 同形，但把「收到多少字节」写进返回值，方便肉眼确认上传链路 ----
    if (req.method === 'POST' && url.pathname === '/anthropic/v1/files') {
      const raw = await readBody(req);
      if (!hasAuth) return json(res, 401, { error: { message: 'missing api key' } });
      if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
        return json(res, 400, { error: { message: 'expected multipart/form-data' } });
      }
      const id = 'file-echo-' + crypto.randomBytes(6).toString('hex');
      calls.push({ at: Date.now(), api: 'files', op: 'create', bytes: raw.length, id });
      return json(res, 200, {
        id, type: 'file', size_bytes: raw.length,
        created_at: new Date().toISOString(),
        filename: 'echo-upload.bin', mime_type: 'application/octet-stream',
      });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/anthropic/v1/files/')) {
      if (!hasAuth) return json(res, 401, { error: { message: 'missing api key' } });
      const fileId = decodeURIComponent(url.pathname.split('/').pop());
      calls.push({ at: Date.now(), api: 'files', op: 'delete', fileId });
      return json(res, 200, { ok: true, deleted: fileId });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tools/asr') {
      const raw = await readBody(req);
      calls.push({ at: Date.now(), api: 'asr', bytes: raw.length });
      // 复读：把音频字节数说出来，ASR 结果可预期，便于前端断言
      return json(res, 200, { text: `[echo asr] 收到 ${raw.length} 字节音频` });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tools/tts') {
      const raw = await readBody(req);
      calls.push({ at: Date.now(), api: 'tts', bytes: raw.length });
      res.writeHead(200, { 'content-type': 'audio/pcm; rate=24000', 'cache-control': 'no-store' });
      // 500ms 24kHz 单声道 16-bit 静音，分 10 块下发（可测音频流式播放）
      const block = Buffer.alloc(2400);
      for (let i = 0; i < 10; i++) { res.write(block); await sleep(20); }
      return res.end();
    }

    return json(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { error: { message: err.message } });
    try { res.end(); } catch { /* ignore */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`echo-upstream（本地复读机）已启动  http://${HOST}:${PORT}`);
  console.log('  测试台      GET  /                      （浏览器直接打开）');
  console.log('  聊天        POST /anthropic/v1/messages  POST /v1/chat/completions');
  console.log('  探测        GET  /models  GET /health');
  console.log('  文件/语音   POST /anthropic/v1/files  POST /v1/tools/asr  POST /v1/tools/tts');
  console.log('  观察        GET  /__calls   POST /__reset');
  console.log('');
  console.log('  接上后台： .env 设 UPSTREAM_BASE_URL=' + `http://${HOST}:${PORT}`);
  console.log('             UPSTREAM_API_KEY=sk-echo-any-non-empty-value');
  console.log('  快速自测： curl -N -H "authorization: Bearer sk-x" -H "content-type: application/json" \\');
  console.log(`             -d '{"model":"echo","stream":true,"messages":[{"role":"user","content":"你好"}]}' \\`);
  console.log(`             http://${HOST}:${PORT}/anthropic/v1/messages`);
});

const shutdown = () => { server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
