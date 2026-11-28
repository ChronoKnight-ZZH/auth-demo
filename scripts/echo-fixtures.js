'use strict';
/**
 * 本地复读机的「内容层」夹具：回复表、搜索结果库、智能体预置任务。
 *
 * 与 echo-upstream.js 分开的原因：
 *   - echo-upstream 负责 HTTP / SSE 协议时序（帧顺序、断流、故障注入）；
 *   - 本文件只负责「说什么」——回复表、思考文本、搜索结果、三个预置智能体任务的脚本。
 *   两部分合起来，让本地复读机在不联网、不花钱的前提下，
 *   复现真实 API 的完整响应逻辑与工作流（思考 → 联网 → 引用 → 工具调用 → 汇总）。
 *
 * 事件脚本（steps）的原子操作，由 echo-upstream 的播放器翻译成 SSE 帧：
 *   { op:'thinking',  chunks:[...], gap }                    思考块（Anthropic thinking_delta / OpenAI reasoning_content）
 *   { op:'search',    kind, queries:[...], results:[...] }   联网搜索：server_tool_use + web_search_tool_result
 *   { op:'read_link', url, page }                            阅读链接：server_tool_use + web_fetch_tool_result
 *   { op:'tool_use',  name, input }                          客户端工具调用（stop_reason=tool_use，需要回传 tool_result）
 *   { op:'text',      chunks:[...], citations:[{url,title,after}] }  正文 + 引用角标
 *   { op:'finish',    stop_reason, title }                   收尾（可带自动生成的会话标题）
 */
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 随机数

/**
 * 可复现的伪随机（mulberry32）。给了 seed 就确定性，方便单测断言「随机回复」的结果；
 * 不给 seed 就是真随机。
 */
function seededRandom(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  let a = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : hashToInt(String(seed));
  if (a === 0) a = 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashToInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 从数组里按随机源取一条（空数组返回 undefined） */
function pickOne(rand, list) {
  if (!list.length) return undefined;
  return list[Math.floor(rand() * list.length) % list.length];
}

/** 从数组里取 n 条（不重复，保持相对顺序稳定，便于肉眼对比） */
function pickSome(rand, list, n) {
  const idx = list.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.max(0, Math.min(n, list.length)))
    .sort((a, b) => a - b)
    .map((i) => list[i]);
}

// ---------------------------------------------------------------- 回复表

/**
 * 回复表：`/mode random`（或 random:true）时从中随机选一条作为正文回复。
 * topic 会写进回复，方便一眼看出「这条是从表里选的哪一条」。
 * 可用 POST /__replies 在运行时替换（演示/教学时可换成自己的话术）。
 */
const REPLY_TABLE = [
  {
    id: 'r01', topic: '打招呼',
    text: '你好，我是本地复读机的演示回复。这条内容来自回复表，不是对你输入的复读。',
  },
  {
    id: 'r02', topic: '天气',
    text: '今天深圳多云转晴，22～28℃，东南风 3 级，湿度 65%。\n\n- 上午：云量较多，体感舒适\n- 下午：紫外线中等，户外注意补水\n- 傍晚：适合散步，日落约 17:35',
  },
  {
    id: 'r03', topic: '代码',
    text: '下面是一段可直接运行的示例：\n\n```js\nconst sum = (arr) => arr.reduce((a, b) => a + b, 0);\nconsole.log(sum([1, 2, 3, 4])); // 10\n```\n\n需要处理空数组时，`reduce` 要补第二个初始值 `0`。',
  },
  {
    id: 'r04', topic: '表格',
    text: '三个方案的对比如下：\n\n| 方案 | 成本 | 上线周期 | 风险 |\n| --- | --- | --- | --- |\n| A 自建 | 高 | 6 周 | 运维压力大 |\n| B 混合 | 中 | 3 周 | 需要联调 |\n| C 托管 | 低 | 1 周 | 供应商锁定 |',
  },
  {
    id: 'r05', topic: '长文本',
    text: '这是一段用于压测流式缓冲的较长回复。' + '内容逐字下发，可以用来观察断点续推、心跳与缓冲截断的实际表现。'.repeat(6),
  },
  {
    id: 'r06', topic: '总结',
    text: '结论：当前瓶颈在 Argon2 并发闸，不在数据库。\n\n依据：\n1. 40 并发下 429 先于慢响应出现；\n2. `/health` 显示会话存储写入均在 1ms 内；\n3. 首字节时间随并发线性上升，符合闸门排队特征。',
  },
  {
    id: 'r07', topic: '列表',
    text: '- 登录：RSA-OAEP 加密传输\n- 存储：Argon2id + pepper\n- 会话：Opaque Token + 版本化撤销\n- 中转：SSE 逐帧透传 + 断点续推',
  },
  {
    id: 'r08', topic: '反问',
    text: '这个问题有两种理解方式：你是想看「接口怎么调」，还是想看「数据怎么流转」？说清楚一点，我可以给出更贴近的答案。',
  },
  {
    id: 'r09', topic: '提醒',
    text: '提醒：这是本地测试上游的预设回复，不会真的联网，也不会产生任何 Token 费用。',
  },
  {
    id: 'r10', topic: '中英混合',
    text: 'Sure — 我可以同时处理中英文。Mixed content streams fine, including emoji 🚀 and punctuation。',
  },
  {
    id: 'r11', topic: '步骤',
    text: '按这三步走：\n\n1. `npm run cert` 生成本地证书\n2. `npm run dev:https` 起 HTTPS 后端\n3. 浏览器访问 <https://127.0.0.1:3000> 并信任证书',
  },
  {
    id: 'r12', topic: '短答',
    text: '收到，本地链路正常。',
  },
];

// ------------------------------------------------------------ 搜索结果库

/**
 * 假搜索结果（联网演示用）。域名一律用 RFC 2606 保留的 example.org/example.com，
 * 保证：看起来像真实搜索结果，但绝不指向任何真实站点。
 */
const SEARCH_RESULTS = [
  {
    title: '深圳市气象台：今日天气公报',
    url: 'https://weather.example.org/shenzhen/today',
    snippet: '今日多云转晴，最高气温 28℃，最低气温 22℃，东南风 3 级，相对湿度 60%～75%。',
    site_name: '深圳市气象台',
    site_icon: 'https://weather.example.org/favicon.ico',
    page_age: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    title: 'DeepSeek 官方文档：流式消息接口',
    url: 'https://docs.example.org/api/create-message',
    snippet: '流式响应以 message_start 开始，message_stop 结束；中途按 content_block_start / delta / stop 组织内容块。',
    site_name: 'DeepSeek Docs',
    site_icon: 'https://docs.example.org/favicon.ico',
    page_age: new Date(Date.now() - 86400_000).toISOString(),
  },
  {
    title: 'Node.js https.createServer 参考手册',
    url: 'https://nodejs.example.org/api/https.html',
    snippet: 'https.createServer(options, requestListener) 需要 key 与 cert；自签名证书在客户端需显式信任或关闭校验。',
    site_name: 'Node.js Guides',
    site_icon: null,
    page_age: new Date(Date.now() - 7 * 86400_000).toISOString(),
  },
  {
    title: 'Argon2id 参数选型建议（2C4G 单机）',
    url: 'https://security.example.org/argon2-tuning',
    snippet: 'm=19MiB、t=2、p=1 在 2 vCPU 上单次约 34ms，配合并发闸可避免哈希抢占事件循环。',
    site_name: 'Security Notes',
    site_icon: 'https://security.example.org/favicon.ico',
    page_age: new Date(Date.now() - 3 * 86400_000).toISOString(),
  },
  {
    title: 'SSE 断线重连与 Last-Event-ID 实践',
    url: 'https://webdev.example.org/sse-resume',
    snippet: '服务端为每个事件编号，客户端重连时带 Last-Event-ID，服务端从缓冲里补齐缺失事件即可续推。',
    site_name: 'WebDev',
    site_icon: null,
    page_age: null,
  },
  {
    title: 'HTTP/2 与 HTTP/1.1 在长连接场景的差异',
    url: 'https://networking.example.org/h2-vs-h1',
    snippet: 'SSE 在 HTTP/1.1 下占用独立连接；代理层需关闭缓冲（X-Accel-Buffering: no）才能逐帧下发。',
    site_name: 'Networking Blog',
    site_icon: 'https://networking.example.org/favicon.ico',
    page_age: new Date(Date.now() - 30 * 86400_000).toISOString(),
  },
  {
    title: 'SQLite 与 MySQL 在小型项目中的取舍',
    url: 'https://db.example.org/sqlite-vs-mysql',
    snippet: '单写多读、并发低于 50 QPS 时 SQLite 运维成本显著更低；需要多实例共享与会话 TTL 时选 MySQL。',
    site_name: 'DB Notes',
    site_icon: null,
    page_age: new Date(Date.now() - 15 * 86400_000).toISOString(),
  },
  {
    title: '前端如何安全存储会话：HttpOnly Cookie vs localStorage',
    url: 'https://frontend.example.org/session-storage',
    snippet: 'HttpOnly Cookie 无法被脚本读取，XSS 窃取难度更高；跨站场景需配合 SameSite 与 Origin 校验。',
    site_name: 'Frontend Sec',
    site_icon: 'https://frontend.example.org/favicon.ico',
    page_age: new Date(Date.now() - 2 * 86400_000).toISOString(),
  },
];

/** 阅读链接（read_link）用的假网页 */
const WEB_PAGES = {
  'https://docs.example.org/api/create-message': {
    title: '流式消息接口 - DeepSeek Docs',
    published_at: new Date(Date.now() - 86400_000).toISOString(),
    summary: '文档描述了 message_start → content_block_* → message_delta → message_stop 的完整事件顺序，'
      + '并给出思考、联网搜索、工具调用三类扩展块的字段定义。',
  },
  'https://weather.example.org/shenzhen/today': {
    title: '今日天气公报 - 深圳市气象台',
    published_at: new Date(Date.now() - 3600_000).toISOString(),
    summary: '全文给出逐三小时温湿风预报，并提示午后紫外线增强，建议户外作业做好防晒与补水。',
  },
};

const DEFAULT_PAGE_URL = 'https://docs.example.org/api/create-message';

// ---------------------------------------------------------------- 文本工具

/** 按标点/空白把长文本切成适合流式下发的增量（每块不超过 size 个字符） */
function splitChunks(text, size = 12) {
  const parts = String(text).match(/[^，。；：！？\n]+[，。；：！？\n]?/g) || [String(text)];
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > size && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf += p;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [String(text)];
}

/** 取问题摘要：去掉命令行，压掉换行，最多 n 字 */
function questionSummary(text, n = 24) {
  const clean = String(text || '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('/'))
    .join(' ')
    .trim();
  const s = clean || '(空问题)';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 从文本里抓第一个 http(s) 链接（备用：命令行/正文两种入口都可复用） */
function firstUrl(text) {
  const m = /https?:\/\/[^\s"'）)】]+/i.exec(String(text || ''));
  return m ? m[0] : '';
}

// ------------------------------------------------------------ 思考文本模板

const THINKING_TEMPLATES = [
  (q) => `用户在问：「${q}」。先判断这属于哪类问题——纯知识、需要实时数据，还是要动工具。`,
  (q) => `「${q}」里的关键约束我需要拆开看：目标是什么、已有什么条件、缺什么信息。`,
  () => '这里的知识有时效性，仅凭训练数据回答有风险，应该先检索再下结论。',
  () => '我需要把答案组织成「结论先行 + 依据 + 下一步」三段，方便用户直接行动。',
  () => '对方可能是开发者，更关心可执行的步骤和参数，而不是概念解释。',
  () => '先列出三种可能的解释，选最贴合上下文的一种，其余在结尾提一句即可。',
];

/** 思考块的增量序列（模板统一收到问题文本，避免出现「undefined」占位） */
function thinkingChunks(rand, question, n = 3) {
  const chosen = pickSome(rand, THINKING_TEMPLATES.map((_, i) => i), n).map((i) => THINKING_TEMPLATES[i]);
  const out = [];
  for (const fn of chosen) {
    out.push(...splitChunks(fn(question), 14));
    out.push('\n');
  }
  return out;
}

// ---------------------------------------------------------- 预置智能体任务

/**
 * 三个预置任务：串起「思考 → 联网 → 引用 → 阅读链接 → 客户端工具 → 汇总」的完整链路。
 * build(ctx) 返回 steps 数组，由 echo-upstream 播放器按流式协议逐帧下发。
 *
 * ctx = { question, rand, urls:[...], fileIds:[...], round, hasToolResult, toolResults:[...], model }
 */
const AGENT_TASKS = [
  {
    id: 1,
    key: 'search-report',
    name: '实时联网问答（思考 → 搜索 → 引用 → 报告）',
    summary: '演示「模型判断需要外部信息 → 发起联网搜索 → 拿到结果 → 边写边标注引用」的完整工作流。',
    workflow: ['thinking（3 段思考）', 'server_tool_use（deepseek_web_search / action=search）',
      'web_search_tool_result（3 条结果）', 'text（正文 + citations_delta 引用）',
      'message_delta（stop_reason=end_turn + server_tool_use 用量）', 'message_stop'],
    build: (ctx) => {
      const q = ctx.question;
      const results = pickSome(ctx.rand, SEARCH_RESULTS, 3);
      // 正文按「结论 → 三条要点（各自带引用）→ 下一步」组织；
      // 引用锚点记录在对应要点之后（after = 该要点结束时的增量序号）。
      const chunks = [];
      const citations = [];
      const add = (parts) => { for (const p of parts) chunks.push(p); };
      add(splitChunks(`### 关于「${q}」的检索结论\n\n`, 20));
      add(splitChunks('先说结论：公开信息足够给出方向性判断，细节以官方页面为准。', 14));
      add(splitChunks('\n\n**要点**\n\n', 12));
      const labels = ['官方口径', '近期报道', '补充来源'];
      results.forEach((r, i) => {
        chunks.push(`${i + 1}. ${labels[i]}：`);
        add(splitChunks(String(r.snippet || ''), 16));
        citations.push({ url: r.url, title: r.title, after: chunks.length });
        chunks.push('\n');
      });
      add(splitChunks('\n**建议下一步**：把上面的口径与你们内部数据对齐一次，'
        + '差异超过预期时再回来找我，我可以针对差异点做第二轮检索。', 14));
      return [
        {
          op: 'thinking',
          gap: 90,
          chunks: [
            ...splitChunks(`用户想知道「${q}」的最新情况。`, 14),
            ...splitChunks('这类信息有时效性，我的训练数据不足以直接回答，需要联网检索。', 14),
            ...splitChunks('拆成两个检索角度：官方口径与近期报道；结果取前几条，交叉核对后再写结论。', 14),
            ['\n'],
          ],
        },
        {
          op: 'search',
          kind: 'search',
          queries: [q, `${q} 最新进展`],
          results,
        },
        { op: 'text', gap: 40, chunks, citations },
        { op: 'finish', stop_reason: 'end_turn', title: `联网检索：${q.slice(0, 12)}` },
      ];
    },
  },
  {
    id: 2,
    key: 'read-analyze',
    name: '链接阅读 + 附件分析（思考 → read_link → 结构化总结）',
    summary: '演示「读取用户消息里的链接 → 抓取网页 → 结合附件/上下文输出结构化总结 → 自动生成会话标题」。',
    workflow: ['thinking', 'server_tool_use（deepseek_read_url / action=read_link）',
      'web_fetch_tool_result（带 signature，供多轮上下文恢复）', 'text（摘要 + 表格）',
      'message_delta（stop_reason=end_turn + title）', 'message_stop'],
    build: (ctx) => {
      const url = ctx.urls[0] || DEFAULT_PAGE_URL;
      const page = WEB_PAGES[url] || {
        title: `页面 ${url.replace(/^https?:\/\//, '')}`,
        published_at: new Date().toISOString(),
        summary: '页面正文抽取成功，主要内容为该链接对应主题的说明与注意事项。',
      };
      const fileNote = ctx.fileIds.length
        ? `本轮还收到 ${ctx.fileIds.length} 个附件引用（file_id：${ctx.fileIds.join('、')}），已在下表一并归纳。`
        : '本轮没有收到附件，结论仅基于链接正文。';
      return [
        {
          op: 'thinking',
          gap: 80,
          chunks: [
            ...splitChunks(`用户给的问题里没有实时数据需求，但附了一个链接，`, 14),
            ...splitChunks('需要先把网页正文读进来，再决定回答粒度。', 14),
            ['\n'],
            ...splitChunks(`${fileNote}我先按「要点 + 可执行清单」组织答案。`, 14),
            ['\n'],
          ],
        },
        { op: 'read_link', url, page },
        {
          op: 'text',
          gap: 40,
          chunks: [
            ...splitChunks(`## 链接内容摘要\n\n`, 20),
            ...splitChunks(`来源：**${page.title}**（发布于 ${String(page.published_at).slice(0, 10)}）\n\n`, 24),
            ...splitChunks(page.summary, 16),
            ...splitChunks(`\n\n## 关键信息\n\n| 项目 | 内容 |\n| --- | --- |\n`, 18),
            ['| 链接 | ', url, ' |\n'],
            ...splitChunks(`| 附件 | ${ctx.fileIds.length ? ctx.fileIds.join(' / ') : '无'} |\n`, 18),
            ...splitChunks(`| 结论可信度 | 高（直接来自页面正文） |\n\n`, 18),
            ...splitChunks(`## 可执行清单\n\n1. 按摘要确认范围是否与你的目标一致；\n`
              + `2. 不一致时告诉我需要侧重哪一节；\n3. 一致则可以直接进入实施。`, 18),
          ],
        },
        { op: 'finish', stop_reason: 'end_turn', title: `链接解读：${page.title.slice(0, 14)}` },
      ];
    },
  },
  {
    id: 3,
    key: 'agent-loop',
    name: '多步智能体（计划 → 工具调用 → 回传结果 → 汇总）',
    summary: '演示跨两轮的智能体循环：第一轮输出计划并以 stop_reason=tool_use 结束，'
      + '客户端执行工具后回传 tool_result，第二轮据此汇总并正常收尾。',
    workflow: ['第 1 轮：thinking（计划）→ text → tool_use → stop_reason=tool_use',
      '客户端执行工具并回传 tool_result',
      '第 2 轮：thinking → text（基于工具结果的汇总）→ stop_reason=end_turn + title'],
    build: (ctx) => {
      // 第二轮：请求里带了 tool_result，据此汇总收尾
      if (ctx.hasToolResult) {
        const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 60) || '（空）';
        const names = ctx.toolNames && ctx.toolNames.length ? ctx.toolNames : ['query_orders'];
        const rows = (ctx.toolResults.length ? ctx.toolResults : [{ preview: '' }])
          .map((r, i) => `| 调用 ${i + 1} | ${cell(names[i % names.length])} | ${cell(r.preview)} |`)
          .join('\n');
        return [
          {
            op: 'thinking',
            gap: 70,
            chunks: [
              ...splitChunks('工具结果已回传，先核对字段是否齐全，再把结论折算成用户关心的指标。', 14),
              ['\n'],
              ...splitChunks('结果与第 1 轮的计划对应，无需再次调用工具，可以直接汇总。', 14),
              ['\n'],
            ],
          },
          {
            op: 'text',
            gap: 40,
            chunks: [
              ...splitChunks(`## 执行结果汇总\n\n`, 20),
              [`| 序号 | 工具 | 返回 |\n| --- | --- | --- |\n`, rows, '\n\n'],
              ...splitChunks(`结论：围绕「${ctx.question}」的三步计划已全部完成。`, 16),
              ...splitChunks(`建议优先处理上面标记为「待确认」的条目；需要继续下钻的话，`
                + `告诉我具体维度，我再发起下一轮工具调用。`, 16),
            ],
          },
          { op: 'finish', stop_reason: 'end_turn', title: `任务执行：${ctx.question.slice(0, 12)}` },
        ];
      }
      // 第一轮：给计划 + 发起客户端工具调用，以 stop_reason=tool_use 结束
      return [
        {
          op: 'thinking',
          gap: 70,
          chunks: [
            ...splitChunks(`目标是「${ctx.question}」。`, 14),
            ...splitChunks('这需要真实数据，我不能凭空编。', 14),
            ['\n'],
            ...splitChunks('计划分三步：① 拉取原始数据 ② 对齐口径 ③ 汇总结论。', 14),
            ['\n'],
            ...splitChunks('第 ① 步需要客户端工具，我先发出调用并停下等结果。', 14),
            ['\n'],
          ],
        },
        {
          op: 'text',
          gap: 40,
          chunks: [
            ...splitChunks(`我先按三步计划推进：\n\n1. 调用 `
              + '`query_orders` 取近 7 天数据；\n', 18),
            ...splitChunks('2. 与已有口径对齐（异常值剔除）；\n3. 汇总并给出结论。\n\n'
              + '现在发起第 1 步的工具调用，等结果回来后继续。', 18),
          ],
        },
        {
          op: 'tool_use',
          name: 'query_orders',
          input: { range: '7d', limit: 5, reason: '需要真实数据支撑结论' },
        },
        { op: 'finish', stop_reason: 'tool_use' },
      ];
    },
  },
];

/** 演示模式说明（测试台 / GET /agent/tasks 直接展示） */
const DEMO_OVERVIEW = {
  title: '智能体演示：完整 API 响应逻辑与工作流',
  notes: [
    '同一条链路里可以看到：思考块、服务端工具调用（联网搜索 / 阅读链接）、搜索结果与引用、'
      + '客户端工具调用（stop_reason=tool_use）、自动会话标题、累计用量。',
    '三种入口等价：消息首行命令（/agent 1）、query（?agent=1）、metadata.mock.agent。',
    '任务 3 需要两轮：第一轮以 tool_use 结束，把返回的 tool_use_id 放进 tool_result 再发一次即可看到汇总。',
    '所有事件都是本地生成的，不联网、不产生费用；配合 /gap、/stopat、/fail 可以顺带演练中断与续推。',
  ],
  tasks: AGENT_TASKS.map((t) => ({
    id: t.id, key: t.key, name: t.name, summary: t.summary, workflow: t.workflow,
  })),
};

module.exports = {
  REPLY_TABLE,
  SEARCH_RESULTS,
  WEB_PAGES,
  DEFAULT_PAGE_URL,
  AGENT_TASKS,
  DEMO_OVERVIEW,
  seededRandom,
  pickOne,
  pickSome,
  splitChunks,
  questionSummary,
  firstUrl,
  thinkingChunks,
  randomId: () => crypto.randomBytes(8).toString('hex'),
};
