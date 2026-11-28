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
 *   GET  /__replies POST /__replies 查看 / 替换「回复表」（随机回复的候选内容）
 *   GET  /__workflow                最近若干次「思考 / 联网 / 智能体」播放的事件轨迹
 *   GET  /agent/tasks               三个预置智能体任务的说明与工作流（演示模式目录）
 *
 * 三种回复形态：
 *   1. 复读（默认）：原样复读最后一条用户消息 + 一行元信息；
 *   2. 随机回复：`/mode random` 或 `random:true`，从回复表里选一条作为正文；
 *   3. 智能体演示：`/agent 1|2|3`，按预置脚本播放完整工作流
 *      （思考块 → 服务端工具调用 → 搜索结果/引用 → 客户端工具 → 汇总 + 会话标题）。
 *
 * 思考与联网（与真实 API 的开关语义一致，两条途径等价）：
 *   - 请求驱动：body.thinking.type === 'enabled' 即出思考块；
 *               body.tools 声明 deepseek_web_search 即出联网搜索块；
 *               用户消息里带 http(s) 链接且声明 deepseek_read_url 即出阅读链接块；
 *   - 命令驱动：`/think`、`/search 3`、`?think=1&search=3`、metadata.mock.{think,search}。
 *   —— 前端把「深度思考 / 智能搜索」开关打开时，本地就能看到对应的完整事件序列。
 *
 * 故障与行为控制（四种等价入口，优先级：请求行内命令 > metadata.mock > query > 环境变量）：
 *   metadata.mock = { fail, gap, tokens, delay, stopAt, repeat, mode, stop,
 *                     random, reply, seed, think, search, results, agent, title }
 *   ?fail=500&gap=200&delay=3000&agent=1    （直连 curl 时最方便）
 *   消息正文首行 `/fail 500`、`/gap 200`、`/delay 3s`、`/repeat 3`、
 *   `/mode upper`、`/mode random`、`/reply 5`、`/seed 42`、`/think`、`/search 3`、`/read`、
 *   `/agent 2`、`/title`、`/stop max_tokens`、`/stopat 5`、`/echo <正文>`
 *   —— 在聊天框里打一行命令就能让上游抽风或换一种回复，不用改任何代码或配置。
 *
 *   fail   : 'network'（直接掐 socket）| 400|429|500|503 | 'errorframe' | 'idle' | 'abort'
 *            | 'refusal'（stop_reason=refusal，前端按协议丢弃思考与正文）
 *   gap    : 每个增量之间的间隔 ms（默认 30）
 *   delay  : 首字节延迟 ms（测 headers 超时 / 前端 loading）
 *   tokens : 强制增量个数（0 = 按正文自然切分）
 *   stopAt : 只发前 N 个增量后收场（测半截续推）
 *   repeat : 把复读内容重复 N 遍（测长回复、缓冲截断）
 *   mode   : 'echo'（默认，原样复读）| 'upper' | 'reverse' | 'count'（只报字数）| 'random'（回复表）
 *   stop   : stop_reason，默认 end_turn
 *   random : true 从回复表随机选一条；reply: 'r04' 或序号指定具体条目；seed 固定随机序列
 *   think  : true/思考块   search: true 或条数（3）→ 联网搜索块 + 引用
 *   agent  : 1|2|3 运行预置智能体任务；title: true 让 message_delta 带上自动会话标题
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fixtures = require('./echo-fixtures');
const play = require('./echo-play');

const PORT = Number(process.argv[2] || process.env.ECHO_PORT || 8788);
const HOST = process.env.ECHO_HOST || '127.0.0.1';
/** 默认在复读前加这一句，方便一眼看出「这轮打到本地了，没花钱」 */
const PREFIX = process.env.ECHO_PREFIX === undefined ? '[echo] ' : process.env.ECHO_PREFIX;

const calls = [];
/** 最近的事件轨迹（GET /__workflow），只留最后 20 次播放 */
const workflows = [];
/** 运行时可替换的回复表（POST /__replies） */
let replyTable = fixtures.REPLY_TABLE.slice();
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
    return { role: String(m.role || '?'), ...flat, refs: collectRefs(m.content) };
  });
  let lastUser = '';
  let lastRefs = { fileIds: [], urls: [], toolResults: [], toolUses: [] };
  for (let i = norm.length - 1; i >= 0; i--) {
    if (norm[i].role === 'user') { lastUser = norm[i].text; lastRefs = norm[i].refs; break; }
  }
  const toolResults = norm.flatMap((m) => m.refs.toolResults);
  const assistantToolUses = norm.flatMap((m) => (m.role === 'assistant' ? m.refs.toolUses : []));
  // 智能体循环第 2 轮：最后一条 user 只有 tool_result（没有正文），话题回退到更早的用户问题
  if (!lastUser && (toolResults.length > 0 || assistantToolUses.length > 0)) {
    for (let i = norm.length - 1; i >= 0; i--) {
      if (norm[i].role === 'user' && norm[i].text) { lastUser = norm[i].text; break; }
    }
  }
  const sysFlat = flattenContent(body.system);
  const openAiSystem = norm.find((m) => m.role === 'system');
  const system = sysFlat.text || (openAiSystem ? openAiSystem.text : '');
  const nonText = norm.filter((m) => m.parts.length).flatMap((m) => m.parts).filter((p) => !p.startsWith('text('));
  // 请求声明的服务端工具（前端「智能搜索 / 阅读链接」开关即体现在这里）
  const declaredTools = (Array.isArray(body.tools) ? body.tools : [])
    .map((t) => String((t && (t.type || t.name)) || ''))
    .filter(Boolean);
  return {
    system,
    lastUser,
    round: norm.filter((m) => m.role === 'user').length,
    history: norm.map((m) => ({ role: m.role, len: m.text.length, blocks: m.parts })),
    nonText,
    fileIds: lastRefs.fileIds,
    urls: lastRefs.urls,
    toolResults,
    hasToolResult: toolResults.length > 0,
    assistantToolUses: [...new Set(assistantToolUses)],
    declaredTools,
    thinkingRequested: Boolean(body.thinking && body.thinking.type === 'enabled'),
    titleRequested: Boolean(body.title && body.title.enabled),
    inputChars: norm.reduce((n, m) => n + m.text.length, 0) + system.length,
  };
}

/** 收集块里的引用信息：file_id、链接、客户端工具回传结果 */
function collectRefs(content) {
  const fileIds = [];
  const urls = [];
  const toolResults = [];
  const toolUses = [];
  const walk = (block) => {
    if (!block) return;
    if (typeof block === 'string') { urls.push(...matchUrls(block)); return; }
    if (typeof block.text === 'string') urls.push(...matchUrls(block.text));
    const id = block.file_id || (block.source && block.source.file_id);
    if (id) fileIds.push(String(id));
    if (block.type === 'tool_use') toolUses.push(String(block.name || '?'));
    if (block.type === 'tool_result') {
      const raw = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((c) => (c && c.text) || '').join('')
          : JSON.stringify(block.content ?? '');
      toolResults.push({ tool_use_id: String(block.tool_use_id || ''), preview: String(raw).slice(0, 120) });
    }
  };
  if (typeof content === 'string') urls.push(...matchUrls(content));
  else if (Array.isArray(content)) content.forEach(walk);
  else if (content && typeof content === 'object') walk(content);
  return { fileIds: [...new Set(fileIds)], urls: [...new Set(urls)], toolResults, toolUses };
}

/** 抓正文里的 http(s) 链接（阅读链接演示用） */
function matchUrls(text) {
  return (String(text).match(/https?:\/\/[^\s"'）)】]+/gi) || []);
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
      // ---- 回复表 / 随机 ----
      else if (key === 'reply') opts.reply = val;
      else if (key === 'random') opts.random = boolOrCount(val);
      else if (key === 'seed') opts.seed = val;
      // ---- 思考 / 联网 / 智能体演示 ----
      else if (key === 'think') opts.think = boolOrCount(val);
      else if (key === 'search') opts.search = boolOrCount(val);
      else if (key === 'read') opts.read = boolOrCount(val);
      else if (key === 'agent') opts.agent = val;
      else if (key === 'title') opts.title = boolOrCount(val);
      continue; // 未知命令：吞掉但不影响复读
    }
    rest.push(line);
  }
  return { text: rest.join('\n').replace(/^\n+/, ''), opts };
}

/** ''/on/1 → true，off/0 → false，数字 → 该数字（/search 3 = 出 3 条结果） */
function boolOrCount(val) {
  const s = String(val === undefined ? '' : val).trim().toLowerCase();
  if (!s) return true;
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  if (s === '1' || s === 'on' || s === 'true' || s === 'yes') return true;
  const n = Number(s);
  return Number.isFinite(n) ? n : true;
}

/** 与 boolOrCount 同义，但把数字视作「条数」，布尔视作默认条数 */
function countOrBool(val, def) {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'number') return val > 0 ? val : 0;
  const s = String(val).trim().toLowerCase();
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 0;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.min(10, Math.floor(n));
  return def;
}

function applyMode(text, mode) {
  switch (mode) {
    case 'upper': return text.toUpperCase();
    case 'reverse': return [...text].reverse().join('');
    case 'count': return `${[...text].length} 字符 / ${text.split(/\s+/).filter(Boolean).length} 词`;
    default: return text;
  }
}

/** 组装复读正文：先给一行「收到什么」的元信息，再原样复读（random 时改为回复表选一条） */
function buildReply(req0, extracted, opts) {
  const applied = opts.random
    ? replyTableText(pickReply(opts))
    : applyMode(req0, opts.mode || process.env.ECHO_MODE || 'echo');
  const bodyLine = applied.startsWith(PREFIX) && opts.random
    ? applied
    : `${PREFIX}${applied}`;
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
  const modeRaw = String(pick(cmd.opts.mode, meta.mode, q.get('mode'), process.env.ECHO_MODE) || 'echo');

  // ---- 回复表 / 随机 ----
  const randomRaw = pick(cmd.opts.random, meta.random, q.get('random'), process.env.ECHO_RANDOM);
  const random = modeRaw === 'random' || (randomRaw !== undefined && boolOrCount(randomRaw) === true);

  // ---- 思考：命令/query/metadata 优先，其次跟随请求里的 thinking.type ----
  const thinkRaw = pick(cmd.opts.think, meta.think, q.get('think'), process.env.ECHO_THINK);
  const think = thinkRaw === undefined ? Boolean(extracted.thinkingRequested) : boolOrCount(thinkRaw) === true;

  // ---- 联网：显式开启（条数），否则跟随请求声明的 deepseek_web_search ----
  const searchRaw = pick(cmd.opts.search, meta.search, q.get('search'), process.env.ECHO_SEARCH);
  const declaredSearch = extracted.declaredTools.includes('deepseek_web_search');
  const searchCount = countOrBool(searchRaw, 3);
  const search = searchRaw === undefined ? declaredSearch : searchCount > 0;

  // ---- 阅读链接：正文里有 http(s) 链接，且（显式开启 或 请求声明了 deepseek_read_url）----
  const readRaw = pick(cmd.opts.read, meta.read, q.get('read'));
  const readLink = readRaw === undefined
    ? extracted.declaredTools.includes('deepseek_read_url') && extracted.urls.length > 0
    : boolOrCount(readRaw) === true && extracted.urls.length > 0;

  return {
    fail: failRaw === undefined ? '' : String(failRaw),
    gap: Math.max(0, Number(gapRaw !== undefined ? gapRaw : 30) || 0),
    tokens: Math.max(0, Number(tokensRaw) || 0),
    delay: delayRaw === undefined ? 0 : (parseMs(delayRaw) || 0),
    stopAt: Math.max(0, Number(stopAtRaw) || 0),
    repeat: Math.max(1, Number(repeatRaw) || 1),
    mode: modeRaw,
    stop: String(pick(cmd.opts.stop, meta.stop, q.get('stop')) || 'end_turn'),
    model: String(body.model || 'echo-model'),
    stream: body.stream !== false,
    /** 命令行之后的正文才是复读对象 */
    text: cmd.text,
    mockKeys: Object.keys(meta).length ? Object.keys(meta).join(',') : null,
    // ---- 新增：回复表 / 思考 / 联网 / 智能体 ----
    // 同 seed → 同一条随机回复 / 同一组搜索结果（单测与演示需要可复现）
    seed: pick(cmd.opts.seed, meta.seed, q.get('seed'), process.env.ECHO_SEED),
    rand: fixtures.seededRandom(pick(cmd.opts.seed, meta.seed, q.get('seed'), process.env.ECHO_SEED)),
    random,
    reply: pick(cmd.opts.reply, meta.reply, q.get('reply'), process.env.ECHO_REPLY),
    think,
    thinkGap: Math.max(0, Number(pick(meta.thinkGap, q.get('thinkGap')) || 90) || 0),
    search,
    searchCount: searchCount === undefined ? 3 : searchCount,
    readLink,
    agent: pick(cmd.opts.agent, meta.agent, q.get('agent'), body.agent, process.env.ECHO_AGENT),
    title: (() => {
      const v = pick(cmd.opts.title, meta.title, q.get('title'));
      return v === undefined ? Boolean(extracted.titleRequested) : boolOrCount(v) === true;
    })(),
  };
}

/** 是否走「协议播放」路径（智能体 / 思考 / 联网 / 阅读 / 回复表随机 任一） */
function isScripted(opts) {
  return Boolean(opts.agent) || opts.think || opts.search || opts.readLink || opts.random;
}

/** 回复表选一条：`/reply r04` 按 id，数字按序号，否则随机 */
function pickReply(opts) {
  const table = replyTable.length ? replyTable : fixtures.REPLY_TABLE;
  if (opts.reply !== undefined && opts.reply !== null && opts.reply !== '') {
    const key = String(opts.reply).trim();
    const byId = table.find((r) => r.id === key);
    if (byId) return byId;
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= table.length) return table[n - 1];
  }
  return fixtures.pickOne(opts.rand, table) || table[0];
}

/** 回复表条目的展示文本：标明来自哪一条，方便肉眼核对 */
function replyTableText(item) {
  return `${PREFIX}回复表 ${item.id}（${item.topic}）\n\n${item.text}`;
}

/** 按 agent 标识（1|2|3 或 key）找预置任务 */
function findTask(ref) {
  const key = String(ref).trim().toLowerCase();
  return fixtures.AGENT_TASKS.find((t) => String(t.id) === key || t.key === key || t.name === ref);
}

/**
 * 组装本次要播放的步骤。
 * - agent：完全按预置任务脚本；
 * - 仅思考/联网：正文仍是复读（或回复表），前面加思考块、搜索块与引用。
 * 返回 null 表示走旧的纯复读路径（保持既有行为逐字节不变）。
 */
function buildSteps(body, extracted, opts) {
  // 工具回传（tool_result）说明这是智能体循环的第 2 轮：即使本轮正文没重复 /agent 3 也继续该任务
  const agentRef = opts.agent || (extracted.hasToolResult && extracted.assistantToolUses.length ? 3 : null);
  if (!agentRef && !isScripted(opts)) return null;
  const ctx = {
    question: fixtures.questionSummary(opts.text || extracted.lastUser || '', 40),
    rawText: opts.text || extracted.lastUser || '',
    rand: opts.rand,
    urls: extracted.urls,
    fileIds: extracted.fileIds,
    round: extracted.round,
    hasToolResult: extracted.hasToolResult,
    toolResults: extracted.toolResults,
    toolNames: extracted.assistantToolUses,
    model: opts.model,
  };

  if (agentRef) {
    const task = findTask(agentRef);
    if (!task) return { error: `unknown agent task: ${agentRef}（可用 1|2|3 或 ${fixtures.AGENT_TASKS.map((t) => t.key).join('|')}）` };
    const steps = task.build(ctx).map((s) => {
      if (s.op === 'thinking' || s.op === 'text') {
        const patched = { ...s, gap: opts.gap || s.gap };
        // 强制增量个数：把该块的正文重新切成 N 块（末块保持内容完整）
        if (opts.tokens > 0 && s.op === 'text') patched.chunks = forceChunks(s.chunks.flat(1).join(''), opts.tokens);
        return patched;
      }
      return s;
    });
    if (opts.title && !steps.some((s) => s.op === 'finish' && s.title)) {
      const fin = steps.find((s) => s.op === 'finish');
      if (fin) fin.title = `演示任务${task.id}：${ctx.question.slice(0, 12)}`;
    }
    return { steps, agent: { id: task.id, key: task.key, name: task.name } };
  }

  const replyText = buildReply(opts.text || '(空消息)', extracted, opts);
  const chunks = opts.tokens > 0 ? forceChunks(replyText, opts.tokens) : chunkText(replyText);
  const steps = [];
  if (opts.think) {
    steps.push({
      op: 'thinking',
      gap: opts.thinkGap,
      chunks: fixtures.thinkingChunks(opts.rand, ctx.question, 3),
    });
  }
  let cited = [];
  if (opts.search) {
    const results = fixtures.pickSome(opts.rand, fixtures.SEARCH_RESULTS, opts.searchCount);
    cited = results;
    steps.push({
      op: 'search',
      kind: 'search',
      queries: [ctx.question, `${ctx.question} 资料`],
      results,
    });
  }
  if (opts.readLink && extracted.urls.length) {
    const url = extracted.urls[0];
    steps.push({ op: 'read_link', url, page: fixtures.WEB_PAGES[url] || { title: url, published_at: null, summary: '' } });
  }
  steps.push({
    op: 'text',
    gap: opts.gap,
    chunks,
    citations: opts.search ? cited.map((r) => ({ url: r.url, title: r.title, after: chunks.length })) : [],
  });
  steps.push({
    op: 'finish',
    stop_reason: opts.stop,
    title: opts.title ? `演示：${ctx.question.slice(0, 12)}` : undefined,
  });
  return { steps, agent: null };
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
body{font:14px/1.6 ui-sans-serif,system-ui;margin:24px;max-width:900px;background:#0f1115;color:#e6e6e6}
textarea{width:100%;height:88px;background:#171a21;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:8px;padding:10px;font:inherit}
button{background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
button.mini{background:#26324a}
pre{white-space:pre-wrap;word-break:break-word;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:12px;min-height:80px;margin:6px 0 16px}
code{background:#171a21;padding:1px 5px;border-radius:4px}
.hint{color:#8b93a1}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:10px 0}
label{color:#c8cede}
h3{margin:18px 0 4px;font-size:15px}
#tl{max-height:300px;overflow:auto;font-size:12.5px;color:#a8d5a2}
#th{color:#c8b39a;min-height:0}
</style>
<h2>本地复读机 · 直连上游测试台</h2>
<p class="hint">这个页面绕开后台登录，直接打本服务，用来单独确认复读机与「思考 / 联网 / 智能体」演示的完整响应流。
正文首行可输入 <code>/fail 500</code> <code>/gap 300</code> <code>/delay 5s</code> <code>/mode upper</code>
<code>/mode random</code> <code>/reply r04</code> <code>/think</code> <code>/search 3</code> <code>/agent 1</code> 等命令。</p>
<div class="row">
  <span class="hint">接口</span>
  <select id="api"><option value="anthropic">Anthropic /anthropic/v1/messages</option><option value="openai">OpenAI /v1/chat/completions</option></select>
  <label><input type="checkbox" id="think"> 思考</label>
  <label><input type="checkbox" id="search"> 联网</label>
  <label><input type="checkbox" id="random"> 回复表随机</label>
  <label><input type="checkbox" id="title"> 生成标题</label>
  <label><input type="checkbox" id="nonstream"> 非流式</label>
</div>
<textarea id="t">你好，复读机！
这是第二轮。</textarea>
<p><button id="go">发送</button> <button class="mini" id="reset">清空输出</button> <span id="s" class="hint"></span></p>
<h3>智能体演示模式（预置三个任务）</h3>
<div class="row" id="tasks"><span class="hint">加载 /agent/tasks …</span></div>
<h3>思考</h3><pre id="th">（勾选「思考」或输入 /think 后显示）</pre>
<h3>正文回复</h3><pre id="o"></pre>
<h3>搜索到的来源</h3><pre id="src">（勾选「联网」或输入 /search 后显示）</pre>
<h3>事件时间线 = 完整 API 响应逻辑</h3><pre id="tl"></pre>
<script>
const $=id=>document.getElementById(id);
const BASE_TEXT=$('t').value;
function commands(){
  const c=[];
  if($('think').checked)c.push('/think');
  if($('search').checked)c.push('/search 3');
  if($('random').checked)c.push('/mode random');
  if($('title').checked)c.push('/title');
  return c.join('\\n');
}
function message(){
  const body=$('t').value.trim();
  const c=commands();
  return c?c+'\\n'+body:body;
}
function short(s){
  const t=typeof s==='string'?s:JSON.stringify(s||{});
  return t.length>90?t.slice(0,90)+'…':t;
}
function log(ev,o){
  let note='';
  if(o){
    if(o.type==='content_block_start'){const b=o.content_block||{};note='block='+b.type+(b.name?' ('+b.name+')':'')+(b.input?' '+short(b.input):'');}
    else if(o.type==='content_block_delta'){const d=o.delta||{};note=d.type+' '+short(d.text||d.thinking||d.signature||(d.citation&&d.citation.url)||d.partial_json||'');}
    else if(o.type==='message_delta'){note='stop_reason='+(o.delta&&o.delta.stop_reason)+(o.delta&&o.delta.title?' title='+o.delta.title:'');if(o.usage)note+=' usage='+JSON.stringify(o.usage);}
    else if(o.type==='message_start'){note=(o.message&&o.message.id)||'';}
    else if(o.choices){const d=(o.choices[0]||{}).delta||{};const f=(o.choices[0]||{}).finish_reason;note=short(d)+(f?' finish='+f:'');}
  }
  $('tl').textContent+='  '+(o&&o.type||ev)+'  '+note+'\\n';
  $('tl').scrollTop=$('tl').scrollHeight;
  if(o&&o.type==='content_block_delta'&&o.delta){
    if(o.delta.type==='text_delta')$('o').textContent+=o.delta.text;
    if(o.delta.type==='thinking_delta')$('th').textContent+=o.delta.thinking;
    if(o.delta.type==='citations_delta')addSource(o.delta.citation.title,o.delta.citation.url);
  }
  if(o&&o.choices&&o.choices[0]&&o.choices[0].delta){
    const d=o.choices[0].delta;
    if(d.content)$('o').textContent+=d.content;
    if(d.reasoning_content)$('th').textContent+=d.reasoning_content;
    if(d.tool_calls)$('tl').textContent+='    tool_calls '+short(d.tool_calls[0].function)+'\\n';
    if(d.references)d.references.forEach(r=>addSource(r.title,r.url));
    if(d.citations)d.citations.forEach(r=>addSource(r.title,r.url));
  }
}
const seen=new Set();
function addSource(title,url){
  if(!url||seen.has(url))return;seen.add(url);
  $('src').textContent+=(seen.size)+'. '+(title||url)+'\\n   '+url+'\\n';
}
async function send(){
  $('o').textContent='';$('tl').textContent='';$('th').textContent='';$('src').textContent='';seen.clear();
  $('s').textContent='连接中…';
  const anthropic=$('api').value==='anthropic';
  const body={model:'echo',stream:!$('nonstream').checked,messages:[{role:'user',content:message()}]};
  if(anthropic){
    body.thinking={type:$('think').checked?'enabled':'disabled'};
    body.tools=[{type:'deepseek_read_url',name:'deepseek_read_url'}];
    if($('search').checked)body.tools.push({type:'deepseek_web_search',name:'deepseek_web_search'});
    if($('title').checked)body.title={enabled:true};
  }
  const r=await fetch(anthropic?'/anthropic/v1/messages':'/v1/chat/completions',
    {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){$('s').textContent='HTTP '+r.status;$('o').textContent=await r.text();return;}
  if($('nonstream').checked){
    const o=await r.json();
    $('tl').textContent='非流式响应 '+JSON.stringify(o).slice(0,600)+'\\n';
    const parts=(o.content||[]).map(b=>b.type==='text'?b.text:(b.type==='thinking'?'':'')).join('');
    $('o').textContent=parts||((o.choices&&o.choices[0]&&o.choices[0].message&&o.choices[0].message.content)||'');
    const th=(o.content||[]).find(b=>b.type==='thinking');
    if(th)$('th').textContent=th.thinking;
    (o.content||[]).filter(b=>b.type==='web_search_tool_result').forEach(b=>b.content.forEach(x=>addSource(x.title,x.url)));
    $('s').textContent='完成（非流式）';
    return;
  }
  $('s').textContent='流式中…';
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){
    const{done,value}=await rd.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    let i;
    while((i=buf.indexOf('\\n\\n'))>=0){
      const frame=buf.slice(0,i);buf=buf.slice(i+2);
      let ev='message',data='';
      for(const line of frame.split('\\n')){
        if(line.startsWith('event:'))ev=line.slice(6).trim();
        else if(line.startsWith('data:'))data+=line.slice(5).trim();
      }
      if(!data||data==='[DONE]')continue;
      let o=null;try{o=JSON.parse(data)}catch(e){}
      log(ev,o);
    }
  }
  $('s').textContent='完成';
}
$('go').onclick=send;
$('reset').onclick=()=>{$('o').textContent='';$('tl').textContent='';$('th').textContent='';$('src').textContent='';};
fetch('/agent/tasks').then(r=>r.json()).then(d=>{
  $('tasks').innerHTML=(d.tasks||[]).map(t=>'<button data-id="'+t.id+'" title="'+t.summary+'">▶ 任务 '+t.id+'：'+t.name+'</button>').join('')
    +(d.notes||[]).map(n=>'<div class="hint">· '+n+'</div>').join('');
  [...$('tasks').querySelectorAll('button')].forEach(b=>b.onclick=()=>{
    $('t').value='/agent '+b.dataset.id+'\\n'+BASE_TEXT;
    $('think').checked=false;$('search').checked=false;$('random').checked=false;
    send();
  });
});
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
      workflows.length = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      if (!hasAuth) return json(res, 401, { error: { message: 'missing api key' } });
      return json(res, 200, { data: [{ id: 'echo-model' }, { id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] });
    }

    // ---- 回复表：查看 / 运行时替换（演示与单测都用它把「随机」变成可断言）----
    if (req.method === 'GET' && url.pathname === '/__replies') {
      return json(res, 200, {
        count: replyTable.length,
        default_count: fixtures.REPLY_TABLE.length,
        replies: replyTable.map((r) => ({ id: r.id, topic: r.topic, chars: [...r.text].length })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/__replies') {
      const body = await readJson(req);
      if (body.reset) { replyTable = fixtures.REPLY_TABLE.slice(); return json(res, 200, { ok: true, count: replyTable.length }); }
      const list = Array.isArray(body.replies) ? body.replies : [];
      const table = list
        .filter((r) => r && typeof r.text === 'string' && r.text)
        .map((r, i) => ({ id: String(r.id || `x${i + 1}`), topic: String(r.topic || '自定义'), text: r.text }));
      if (!table.length) return json(res, 400, { error: { message: 'replies 需要是非空数组，每项含 text' } });
      replyTable = table;
      return json(res, 200, { ok: true, count: replyTable.length });
    }

    // ---- 工作流轨迹：最近若干次「思考 / 联网 / 智能体」播放的事件序列 ----
    if (req.method === 'GET' && url.pathname === '/__workflow') {
      return json(res, 200, { runs: workflows.slice(-20).reverse() });
    }

    // ---- 智能体演示目录：三个预置任务 + 用法 ----
    if (req.method === 'GET' && url.pathname === '/agent/tasks') {
      return json(res, 200, fixtures.DEMO_OVERVIEW);
    }

    // ---- 聊天（复读核心 + 思考/联网/智能体演示）----
    const isAnthropic = req.method === 'POST' && url.pathname === '/anthropic/v1/messages';
    const isOpenAi = req.method === 'POST' && url.pathname === '/v1/chat/completions';
    if (isAnthropic || isOpenAi) {
      const body = await readJson(req);
      const extracted = extractRequest(body);
      const opts = resolveOpts(body, url, extracted);
      // 拒绝演示：与真实 API 一致，stop_reason 折叠为 refusal（前端按协议丢弃思考与正文）
      if (opts.fail === 'refusal') opts.stop = 'refusal';
      const scripted = buildSteps(body, extracted, opts);
      if (scripted && scripted.error) {
        return json(res, 400, { error: { type: 'invalid_request_error', message: scripted.error } });
      }
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
        // ---- 新增维度：这轮走了哪些能力（前端开关 / 命令行都会体现在这里）----
        capability: scripted
          ? (scripted.agent ? `agent:${scripted.agent.id}` : 'echo+script')
          : (opts.random ? 'random' : 'echo'),
        agent: scripted && scripted.agent ? scripted.agent.name : null,
        thinking: opts.think,
        webSearch: opts.search ? opts.searchCount : false,
        readLink: opts.readLink ? (extracted.urls[0] || true) : false,
        randomReply: opts.random,
        replyId: opts.random && opts.reply !== undefined ? String(opts.reply) : null,
        declaredTools: extracted.declaredTools,
        fileRefs: extracted.fileIds,
        hasToolResult: extracted.hasToolResult,
        assistantToolUses: extracted.assistantToolUses,
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

      // ---- 协议播放路径：智能体任务 / 思考 / 联网 / 阅读 / 回复表随机 ----
      if (scripted) {
        const blocks = play.planBlocks(scripted.steps, { inputChars: extracted.inputChars });
        const finish = play.planFinish(scripted.steps, blocks, { inputChars: extracted.inputChars });
        workflows.push(play.workflowOf(scripted.steps, blocks, finish, {
          api: isAnthropic ? 'anthropic' : 'openai',
          agent: scripted.agent,
          model: opts.model,
          question: fixtures.questionSummary(extracted.lastUser || '', 40),
          stream: opts.stream,
        }));
        if (workflows.length > 60) workflows.splice(0, workflows.length - 60);

        if (!opts.stream) {
          if (isAnthropic) {
            return json(res, 200, play.anthropicMessage(blocks, finish, opts.model, 'echo_' + crypto.randomBytes(6).toString('hex')));
          }
          return json(res, 200, play.openAiCompletion(blocks, finish, opts.model, 'chatcmpl-echo-' + crypto.randomBytes(5).toString('hex')));
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        try {
          return isAnthropic
            ? await play.playAnthropic(res, {
                blocks, finish, model: opts.model, opts, sleep,
                msgId: 'echo_' + crypto.randomBytes(6).toString('hex'),
              })
            : await play.playOpenAi(res, {
                blocks, finish, model: opts.model, opts, sleep,
                id: 'chatcmpl-echo-' + crypto.randomBytes(5).toString('hex'),
              });
        } catch { /* 客户端已断开 */ }
        return;
      }

      // ---- 旧路径：纯复读（保持既有行为逐字节不变）----
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
  console.log('  测试台      GET  /                      （浏览器直接打开，含智能体演示按钮）');
  console.log('  聊天        POST /anthropic/v1/messages  POST /v1/chat/completions');
  console.log('  探测        GET  /models  GET /health');
  console.log('  文件/语音   POST /anthropic/v1/files  POST /v1/tools/asr  POST /v1/tools/tts');
  console.log('  观察        GET /__calls  GET /__workflow  GET /__replies  POST /__replies  POST /__reset');
  console.log('  智能体演示  GET  /agent/tasks            （三个预置任务的说明与工作流）');
  console.log('');
  console.log('  能力开关    /think  /search 3  /mode random  /reply r04  /agent 1|2|3  /title');
  console.log('              （也可用 ?think=1&search=3&agent=1 或 metadata.mock，或跟随请求里的');
  console.log('               thinking / tools 声明自动开启）');
  console.log('');
  console.log('  接上后台： .env 设 UPSTREAM_BASE_URL=' + `http://${HOST}:${PORT}`);
  console.log('             UPSTREAM_API_KEY=sk-echo-any-non-empty-value');
  console.log('  快速自测： curl -N -H "authorization: Bearer sk-x" -H "content-type: application/json" \\');
  console.log(`             -d '{"model":"echo","stream":true,"messages":[{"role":"user","content":"/agent 1\\n深圳明天天气怎么样"}]}' \\`);
  console.log(`             http://${HOST}:${PORT}/anthropic/v1/messages`);
});

const shutdown = () => { server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
