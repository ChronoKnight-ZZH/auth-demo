'use strict';
/**
 * 统一配置。所有可调数值集中在此，对应方案 §4、§6.3、§10。
 * 环境变量优先，缺省值即方案定稿的默认值。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 不是合法数字: ${v}`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * pepper 来源：优先 PEPPER 环境变量；否则从 PEPPER_FILE 读取
 * （systemd LoadCredential= 注入场景，避免明文进 EnvironmentFile）。
 */
function readPepper() {
  if (process.env.PEPPER) return process.env.PEPPER;
  const p = process.env.PEPPER_FILE;
  if (p) {
    try {
      return require('node:fs').readFileSync(p, 'utf8').trim();
    } catch (e) {
      throw new Error(`PEPPER_FILE 读取失败 (${p}): ${e.message}`);
    }
  }
  return '';
}

/**
 * 是否由应用自身终结 TLS。
 * 先于 config 计算：trustProxy / cookie.secure 的默认值都依赖它。
 */
const tlsEnabled = bool('TLS_ENABLED', false);

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 3000),
  host: process.env.HOST || '127.0.0.1', // 方案 §6.5：只监听回环，由 Nginx 终结 TLS
  /**
   * trust proxy：默认信任 1 跳（Nginx 反代，方案 §6.5）。
   * 应用自身终结 TLS 时（TLS_ENABLED=1）默认**不信任**任何代理头：
   * 否则客户端伪造的 X-Forwarded-Proto 会污染 req.protocol，
   * 进而影响 CSRF 的同源判定。此时若确实前面还有代理，显式设 TRUST_PROXY=1。
   */
  trustProxy: (() => {
    const v = process.env.TRUST_PROXY;
    if (v === undefined || v === '') return !tlsEnabled;
    return v === '1' || v.toLowerCase() === 'true';
  })(),

  // ---- TLS（本地 HTTPS 联调；生产仍由 Nginx 终结 TLS，应用只监听回环 HTTP）----
  // 本地要直连 https://127.0.0.1:3000 时：
  //   npm run cert          # 生成自签名证书到 secrets/tls_cert.pem + secrets/tls_key.pem
  //   TLS_ENABLED=1 npm start
  tls: {
    /** 开启后由应用自身终结 TLS（https.createServer） */
    enabled: tlsEnabled,
    /** 证书路径（默认仓库 secrets/tls_cert.pem，可用环境变量覆盖） */
    certPath: process.env.TLS_CERT_PATH || path.join(__dirname, '..', 'secrets', 'tls_cert.pem'),
    /** 私钥路径（默认仓库 secrets/tls_key.pem） */
    keyPath: process.env.TLS_KEY_PATH || path.join(__dirname, '..', 'secrets', 'tls_key.pem'),
    /** 可选：附加 CA 证书（PEM），用于自签链 / 企业 CA 场景 */
    caPath: process.env.TLS_CA_PATH || '',
    /**
     * 额外起一个纯 HTTP 监听端口并 301 跳转到 HTTPS。
     * 0 = 不启用（默认）。生产由 Nginx 做跳转，本项仅用于本地模拟「HTTP→HTTPS 强制」。
     */
    redirectHttpPort: int('TLS_REDIRECT_HTTP_PORT', 0),
    /** 跳转时使用的 Host；留空 = 取请求的 Host 头 */
    redirectHost: process.env.TLS_REDIRECT_HOST || '',
  },

  // ---- CORS（前后端分域部署才需要；同源 Nginx 反代保持留空）----
  cors: {
    /** 逗号分隔的来源白名单，如 https://chat.shunkai-dg.cn；`*` = 反射任意来源 */
    origins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 预检结果缓存秒数 */
    maxAgeSec: int('CORS_MAX_AGE_SEC', 600),
  },

  // ---- RSA / OAEP（方案 §3.1、§6.2.1）----
  rsa: {
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',        // JSEncrypt 的 OAEP 固定 SHA-256，不可改 sha1
    maxPlaintextBytes: 190,    // RSA-2048 + OAEP-SHA256 = 256 - 2*32 - 2
    privateKeyPath: process.env.RSA_PRIVATE_KEY_PATH || 'secrets/rsa_private.pem',
    publicKeyPath: process.env.RSA_PUBLIC_KEY_PATH || 'secrets/rsa_public.pem',
  },

  // ---- Argon2id（方案 §6.2.2：按 2C4G 下调档位）----
  argon2: {
    memoryCost: int('ARGON2_MEMORY_KIB', 19456), // 19 MiB，非 65536
    timeCost: int('ARGON2_TIME_COST', 2),
    parallelism: int('ARGON2_PARALLELISM', 1),   // 2 vCPU 上不可用 4
    secret: readPepper(),
  },

  // ---- 会话（方案 §6.3、§10 Q-04 定稿）----
  session: {
    idleMs: int('SESSION_IDLE_MS', 30 * 60 * 1000),          // 30 min
    absoluteMs: int('SESSION_ABSOLUTE_MS', 7 * 24 * 3600 * 1000), // 7 d
    touchThrottleMs: int('SESSION_TOUCH_THROTTLE_MS', 5 * 60 * 1000), // 5 min
  },

  // ---- 会话 Cookie（HttpOnly 由后端下发；前端不再持有 token 原文）----
  // 对应改造：Bearer Token → HttpOnly Cookie。前端只发 credentials: include，
  // 浏览器自动携带；状态变更请求由 CSRF 中间件校验 Origin/Referer 白名单。
  cookie: {
    /** 会话 Cookie 名 */
    name: process.env.SESSION_COOKIE_NAME || 'authdemo.session',
    /** Cookie Path */
    path: process.env.SESSION_COOKIE_PATH || '/',
    /**
     * Cookie Domain。留空 = host-only（同源反代推荐，最收敛）；
     * 分域直连（chat.X 直连 api.X）时设为 `.shunkai-dg.cn` 让兄弟子域共享。
     * 注意：写死成 api.域名会导致浏览器不把 Cookie 发给 chat.域名。
     */
    domain: process.env.SESSION_COOKIE_DOMAIN || '',
    /**
     * SameSite：lax = 同站可带、挡跨站（默认，配合 Origin 白名单够用）；
     * none = 真正跨站才用，必须同时 Secure。
     */
    sameSite: (process.env.SESSION_COOKIE_SAMESITE || 'lax').toLowerCase(),
    /**
     * Secure：留空时按环境自动（production = true；本地启用 TLS 时也为 true）。
     * 同源反代由 Nginx 终结 TLS，应用只监听回环，trustProxy 已开，Secure 不影响下发。
     */
    secure: (() => {
      const v = process.env.SESSION_COOKIE_SECURE;
      if (v === undefined || v === '') {
        return process.env.NODE_ENV === 'production' || tlsEnabled;
      }
      return v === '1' || v.toLowerCase() === 'true';
    })(),
    /** CSRF 防护开关：状态变更请求（POST/PUT/PATCH/DELETE）校验 Origin/Referer 白名单 */
    csrfEnabled: bool('CSRF_ENABLED', true),
  },

  // ---- 登录限流（方案 §6.2.5、§10 Q-06 定稿）----
  login: {
    maxPerAccount: int('LOGIN_MAX_PER_ACCOUNT', 10), // 10 次 / 15 min
    maxPerIp: int('LOGIN_MAX_PER_IP', 50),           // 50 次 / 15 min
    windowSec: int('LOGIN_WINDOW_SEC', 900),         // 15 min
  },

  // ---- Argon2 并发闸（方案 §6.2.6）----
  hashGate: {
    maxConcurrent: int('MAX_CONCURRENT_HASH', 2), // ≤ vCPU/2
    queueLimit: int('HASH_QUEUE_LIMIT', 32),
    queueTimeoutMs: int('HASH_QUEUE_TIMEOUT_MS', 1000),
  },

  // ---- 存储后端 ----
  mysql: {
    url: process.env.MYSQL_URL || '',
    poolSize: int('MYSQL_POOL_SIZE', 8),
  },
  redis: {
    url: process.env.REDIS_URL || '',
  },

  // ---- 上游中转（Key 只存服务端 env，绝不出网关）----
  upstream: {
    // 生产 = https://api.deepseek.com；本地冒烟可指向 mock 服务
    baseUrl: (process.env.UPSTREAM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: process.env.UPSTREAM_API_KEY || '',
    messagesPath: process.env.UPSTREAM_MESSAGES_PATH || '/anthropic/v1/messages',
    modelsPath: process.env.UPSTREAM_MODELS_PATH || '/models',
    filesPath: process.env.UPSTREAM_FILES_PATH || '/anthropic/v1/files',
    asrPath: process.env.UPSTREAM_ASR_PATH || '/v1/tools/asr',
    ttsPath: process.env.UPSTREAM_TTS_PATH || '/v1/tools/tts',
    /** 账户余额查询（GET /user/balance） */
    balancePath: process.env.UPSTREAM_BALANCE_PATH || '/user/balance',
    /** 余额查询总时限：只读小请求，不应和聊天共用 10 分钟 */
    balanceTimeoutMs: int('UPSTREAM_BALANCE_TIMEOUT_MS', 15_000),
    /** 首字节（响应头）超时 */
    headersTimeoutMs: int('UPSTREAM_HEADERS_TIMEOUT_MS', 30_000),
    /** 相邻两个数据块之间的静默超时（比总超时更适合流式） */
    idleTimeoutMs: int('UPSTREAM_IDLE_TIMEOUT_MS', 120_000),
    /** 单次上游请求的总时限（含全部 token 传输） */
    totalTimeoutMs: int('UPSTREAM_TOTAL_TIMEOUT_MS', 600_000),
    /** 允许中转的模型白名单（逗号分隔；空 = 不限制） */
    allowedModels: (process.env.UPSTREAM_ALLOWED_MODELS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  // ---- SSE 流式与断点续推 ----
  stream: {
    /** 全局并发流上限（含孤儿生产者），超出 429 RELAY_BUSY */
    maxConcurrent: int('STREAM_MAX_CONCURRENT', 64),
    /** 单用户并发流上限 */
    maxPerUser: int('STREAM_MAX_PER_USER', 4),
    /** 心跳间隔：Nginx/代理空闲断连的防线 */
    heartbeatMs: int('SSE_HEARTBEAT_MS', 10_000),
    /** 单条流缓冲的事件上限（超出从头截断，续推时返回 410） */
    bufferMaxEvents: int('STREAM_BUFFER_MAX_EVENTS', 8000),
    /** 单条流缓冲的字节上限 */
    bufferMaxBytes: int('STREAM_BUFFER_MAX_BYTES', 4 * 1024 * 1024),
    /** 缓冲 TTL：结束后仍可续推的时间窗 */
    bufferTtlMs: int('STREAM_BUFFER_TTL_MS', 10 * 60 * 1000),
    /** 客户端断开后，生产者继续向上游收流的时限（保护续推能力，同时封顶成本） */
    orphanTimeoutMs: int('STREAM_ORPHAN_TIMEOUT_MS', 90 * 1000),
    /** 续推时 tail 轮询缓冲的间隔 */
    tailPollMs: int('STREAM_TAIL_POLL_MS', 120),
    /** inflight 流在本进程没有生产者时（跨实例续推）允许的静默时长，超出即判死 */
    tailStallMs: int('STREAM_TAIL_STALL_MS', 120_000),
    /** 上游重试：仅在【首字节之前】重试，已产出 token 后不重试（避免重复计费/重复内容） */
    retry: {
      maxAttempts: int('UPSTREAM_RETRY_MAX', 2),
      baseBackoffMs: int('UPSTREAM_RETRY_BASE_MS', 300),
      maxBackoffMs: int('UPSTREAM_RETRY_MAX_MS', 3000),
    },
    /** 熔断器：滑动窗口内失败达到阈值则打开，冷却后半开试探 */
    circuit: {
      failureThreshold: int('BREAKER_FAILURE_THRESHOLD', 5),
      windowMs: int('BREAKER_WINDOW_MS', 60_000),
      cooldownMs: int('BREAKER_COOLDOWN_MS', 30_000),
    },
  },

  // ---- 响应缓存（默认关闭：中转语义以「每次真发」为默认，缓存是显式优化）----
  cache: {
    enabled: bool('CACHE_ENABLED', false),
    ttlMs: int('CACHE_TTL_MS', 15 * 60 * 1000),
    maxEntryBytes: int('CACHE_MAX_ENTRY_BYTES', 2 * 1024 * 1024),
    /** 命中窗口内是否允许跨用户共享。默认 0：缓存键含 userId，只复用同一用户自己的历史响应 */
    crossUser: bool('CACHE_CROSS_USER', false),
  },

  // ---- 附件原件存储（里程碑 3）----
  files: {
    /**
     * local：服务端保存原件并签发短期票据；
     * off：关闭服务端文件能力，前端退回纯 IndexedDB。
     */
    mode: process.env.FILES_MODE === 'off' ? 'off' : 'local',
    /** 原件目录，默认仓库内 data/files（生产请挂载独立磁盘） */
    dir: process.env.FILES_DIR || path.join(__dirname, '..', 'data', 'files'),
    /** 单文件上限，与前端 MAX_SIZE_MB 对齐 */
    maxBytes: int('FILES_MAX_BYTES', 64 * 1024 * 1024),
    /** 文本内联预览的转码上限：超过此大小的文本仍按附件下载，避免大文件占满内存 */
    textMaxBytes: int('FILES_TEXT_MAX_BYTES', 16 * 1024 * 1024),
    /** 票据 HMAC 密钥；缺省时用 PEPPER 派生（仅本地开发） */
    tokenSecret: process.env.FILE_TOKEN_SECRET || '',
    tokenTtlMs: int('FILE_TOKEN_TTL_MS', 30 * 60 * 1000),
    /** global：跨用户按 sha256 去重；user：只在用户内去重 */
    dedupeScope: process.env.DEDUPE_SCOPE === 'user' ? 'user' : 'global',
    /** 票据密钥标识，支持轮换 */
    keyId: process.env.FILE_TOKEN_KID || 'k1',
    /**
     * /files/content 的 Cross-Origin-Resource-Policy（<img> 能否跨源加载，独立于 CORS）。
     * 留空时按部署形态自动选择：
     *   - 分域直连（CORS_ORIGINS 非空）→ same-site：chat.X 可内嵌 api.X 图片（同 eTLD+1），
     *     仍拦掉真正跨站的盗链。
     *   - 同源反代（CORS_ORIGINS 为空）→ same-origin：与历史行为逐字节一致。
     * 前端与后端不同「站点」（如 github.io 预览直连本站）时显式设 cross-origin。
     */
    corp: (() => {
      const v = (process.env.FILES_CORP || '').trim();
      if (v === 'same-origin' || v === 'same-site' || v === 'cross-origin') return v;
      const hasCors = (process.env.CORS_ORIGINS || '').split(',').some((s) => s.trim());
      return hasCors ? 'same-site' : 'same-origin';
    })(),
  },

  // ---- Agent Harness（第一阶段：任务基础设施；执行器默认关闭）----
  agent: {
    /** 总开关：生产默认关闭，灰度时显式开启 */
    enabled: bool('AGENT_ENABLED', false),
    /** 逗号分隔的用户 ID 白名单；为空 = 不额外限制（仍受 enabled 约束） */
    allowlist: (process.env.AGENT_ALLOWLIST || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    /** 执行器是否就绪；阶段 2/3 接入模型和 Docker 前置条件 */
    executionEnabled: bool('AGENT_EXECUTION_ENABLED', false),
    /** 模型名称；地址、Key 与 messagesPath 复用 upstream 配置 */
    model: process.env.AGENT_MODEL || 'deepseek-chat',
    maxTokens: int('AGENT_MAX_TOKENS', 4096),
    /** 任务总时限与单次脚本时限 */
    taskTimeoutMs: int('AGENT_TASK_TIMEOUT_MS', 600_000),
    scriptTimeoutMs: int('AGENT_SCRIPT_TIMEOUT_MS', 120_000),
    /** 调用预算 */
    maxModelCalls: int('AGENT_MAX_MODEL_CALLS', 12),
    maxToolCalls: int('AGENT_MAX_TOOL_CALLS', 20),
    /** 文件限制 */
    maxInputFiles: int('AGENT_MAX_INPUT_FILES', 20),
    maxInputBytes: int('AGENT_MAX_INPUT_BYTES', 128 * 1024 * 1024),
    maxOutputBytes: int('AGENT_MAX_OUTPUT_BYTES', 64 * 1024 * 1024),
    maxOutputFiles: int('AGENT_MAX_OUTPUT_FILES', 10),
    userQuotaBytes: int('AGENT_USER_QUOTA_BYTES', 20 * 1024 * 1024 * 1024),
    /** 保留期（清理任务在后续阶段接入） */
    retentionDays: int('AGENT_RETENTION_DAYS', 30),
    logRetentionDays: int('AGENT_LOG_RETENTION_DAYS', 7),
    outputRetentionDays: int('AGENT_OUTPUT_RETENTION_DAYS', 30),
    /** 任务工作目录根；生产请挂独立数据盘 */
    workspaceDir: process.env.AGENT_WORKSPACE_DIR || path.join(__dirname, '..', 'data', 'agent'),
    /** Docker 执行限制（阶段 3 使用；先集中配置，避免散落硬编码） */
    pythonImage: process.env.AGENT_PYTHON_IMAGE || 'agent-python:1',
    containerMemoryBytes: int('AGENT_CONTAINER_MEMORY_BYTES', 768 * 1024 * 1024),
    containerCpus: (() => {
      const value = Number(process.env.AGENT_CONTAINER_CPUS || 1);
      return Number.isFinite(value) && value > 0 ? value : 1;
    })(),
    containerPidsLimit: int('AGENT_CONTAINER_PIDS_LIMIT', 128),
    /** 队列：off（只落库，不消费）/ inline（进程内执行，仅开发）/ bullmq */
    queueMode: (process.env.AGENT_QUEUE_MODE || 'off').toLowerCase(),
    queueName: process.env.AGENT_QUEUE_NAME || 'agent-tasks',
    queuePrefix: process.env.AGENT_QUEUE_PREFIX || 'agent',
    /** Redis 异常时不能拖住 API：投递超时后任务保持 queued，由巡检/补偿接管 */
    queueEnqueueTimeoutMs: int('AGENT_QUEUE_ENQUEUE_TIMEOUT_MS', 3_000),
    /**
     * 排队上限：任务停留在 queued 超过这个时间仍没人领取，判定 timed_out。
     * 没有它，queue=off / bullmq 但 Worker 未启动时，任务会永远停在 queued，
     * 前端只能无限轮询（表现为「长时间无响应」）。
     */
    queueTimeoutMs: int('AGENT_QUEUE_TIMEOUT_MS', 60_000),
    workerConcurrency: int('AGENT_WORKER_CONCURRENCY', 1),
    /** Agent 独立连接池；2C4G 机器不宜与现有池叠加过大 */
    mysqlPoolSize: int('AGENT_MYSQL_POOL_SIZE', 4),
  },

  // ---- 其他 ----
  bodyLimit: process.env.BODY_LIMIT || '16kb',
  /** /v1 聊天请求体上限：附件按 file_id 引用，正文本身不需要很大 */
  chatBodyLimit: process.env.CHAT_BODY_LIMIT || '4mb',
  maxMessages: int('CHAT_MAX_MESSAGES', 200),
  maxUsernameChars: 64,
};

/** 启动自检必须项（方案 A-B-03） */
function validateConfig() {
  const errors = [];
  if (!config.argon2.secret) errors.push('PEPPER 未设置（pepper 必须外置注入）');
  if (config.argon2.memoryCost < 8192) errors.push('ARGON2_MEMORY_KIB 过低（< 8 MiB）');
  if (config.session.idleMs >= config.session.absoluteMs) {
    errors.push('SESSION_IDLE_MS 必须小于 SESSION_ABSOLUTE_MS');
  }
  if (config.stream.bufferTtlMs > config.session.absoluteMs) {
    errors.push('STREAM_BUFFER_TTL_MS 不得大于 SESSION_ABSOLUTE_MS');
  }
  if (config.stream.heartbeatMs * 6 > config.session.idleMs) {
    errors.push('SSE_HEARTBEAT_MS 相对 SESSION_IDLE_MS 过大，心跳无法在空闲窗口内维持会话');
  }
  const ss = String(config.cookie.sameSite).toLowerCase();
  if (!['lax', 'strict', 'none'].includes(ss)) {
    errors.push('SESSION_COOKIE_SAMESITE 必须是 lax / strict / none 之一');
  }
  if (ss === 'none' && !config.cookie.secure) {
    errors.push('SESSION_COOKIE_SAMESITE=none 必须同时设置 SESSION_COOKIE_SECURE=true');
  }
  if (!['off', 'inline', 'bullmq'].includes(config.agent.queueMode)) {
    errors.push('AGENT_QUEUE_MODE 必须是 off / inline / bullmq 之一');
  }
  if (config.agent.taskTimeoutMs < 1000) {
    errors.push('AGENT_TASK_TIMEOUT_MS 不得小于 1000ms');
  }
  if (config.agent.scriptTimeoutMs <= 0 || config.agent.scriptTimeoutMs >= config.agent.taskTimeoutMs) {
    errors.push('AGENT_SCRIPT_TIMEOUT_MS 必须大于 0 且小于 AGENT_TASK_TIMEOUT_MS');
  }
  if (config.agent.maxModelCalls < 1 || config.agent.maxToolCalls < 1) {
    errors.push('AGENT_MAX_MODEL_CALLS / AGENT_MAX_TOOL_CALLS 必须大于 0');
  }
  if (config.agent.maxInputFiles < 0 || config.agent.maxOutputFiles < 0) {
    errors.push('AGENT_MAX_INPUT_FILES / AGENT_MAX_OUTPUT_FILES 不得为负数');
  }
  // 2C4G 基线：全局只允许一个任务执行，避免容器与 API 争抢内存/CPU
  if (config.agent.workerConcurrency !== 1) {
    errors.push('AGENT_WORKER_CONCURRENCY 阶段 1 必须为 1');
  }
  if (config.agent.queueEnqueueTimeoutMs < 100) {
    errors.push('AGENT_QUEUE_ENQUEUE_TIMEOUT_MS 不得小于 100ms');
  }
  if (config.agent.queueTimeoutMs < 1000) {
    errors.push('AGENT_QUEUE_TIMEOUT_MS 不得小于 1000ms（否则任务刚提交就会被判排队超时）');
  }
  if (config.agent.queueTimeoutMs >= config.agent.taskTimeoutMs) {
    errors.push('AGENT_QUEUE_TIMEOUT_MS 必须小于 AGENT_TASK_TIMEOUT_MS');
  }
  if (config.agent.retentionDays < 1
    || config.agent.logRetentionDays < 1
    || config.agent.outputRetentionDays < 1) {
    errors.push('AGENT_RETENTION_DAYS / AGENT_LOG_RETENTION_DAYS / AGENT_OUTPUT_RETENTION_DAYS 必须大于 0');
  }
  if (config.agent.enabled && config.agent.queueMode === 'bullmq' && !config.redis.url) {
    errors.push('AGENT_QUEUE_MODE=bullmq 需要 REDIS_URL');
  }
  if (config.tls.enabled) {
    if (!fs.existsSync(config.tls.certPath)) {
      errors.push(`TLS_CERT_PATH 不存在: ${config.tls.certPath}（先执行 npm run cert）`);
    }
    if (!fs.existsSync(config.tls.keyPath)) {
      errors.push(`TLS_KEY_PATH 不存在: ${config.tls.keyPath}（先执行 npm run cert）`);
    }
    if (config.tls.caPath && !fs.existsSync(config.tls.caPath)) {
      errors.push(`TLS_CA_PATH 不存在: ${config.tls.caPath}`);
    }
    if (config.tls.redirectHttpPort && config.tls.redirectHttpPort === config.port) {
      errors.push('TLS_REDIRECT_HTTP_PORT 不得与 PORT 相同');
    }
  }
  return errors;
}

/**
 * 非致命提示：中转能力的前置条件。缺失时 /v1/* 返回 503，
 * 但登录链路仍可独立运行（Demo/零依赖模式）。
 */
function configWarnings() {
  const warnings = [];
  if (!config.upstream.apiKey) {
    warnings.push('UPSTREAM_API_KEY 未设置 —— /v1/chat/stream 将返回 503 UPSTREAM_NOT_CONFIGURED');
  }
  if (config.cache.enabled && config.cache.crossUser) {
    warnings.push('CACHE_CROSS_USER=1 已开启跨用户复用，多租户部署请显式确认此取舍');
  }
  if (config.files.mode === 'local' && !config.files.tokenSecret) {
    warnings.push('FILE_TOKEN_SECRET 未设置 —— 文件票据将使用 PEPPER 派生密钥，生产环境请显式配置');
  }
  if (config.env === 'production' && config.cors.origins.length === 0) {
    warnings.push(
      'CORS_ORIGINS 未设置 —— 按同源反代部署运行；若前端在别的域名直连本站，跨域请求会被浏览器拦截'
    );
  }
  if (config.agent.enabled && config.agent.allowlist.length === 0) {
    warnings.push('AGENT_ALLOWLIST 为空 —— 所有已登录用户都可创建 Agent 任务');
  }
  if (config.agent.enabled && !config.agent.executionEnabled) {
    warnings.push('AGENT_EXECUTION_ENABLED=0 —— Agent 任务只会落库排队，不会被执行');
  }
  if (config.agent.enabled && config.agent.queueMode === 'off') {
    warnings.push('AGENT_QUEUE_MODE=off —— 任务不会投递到队列，需由后续 Worker 阶段接管');
  }
  if (config.tls.enabled && /tls_cert|self-?signed|dev/i.test(config.tls.certPath)) {
    warnings.push(
      'TLS 使用本地自签名证书 —— 浏览器会提示「不安全」，需手动信任证书或临时放行；生产证书由 Nginx 终结'
    );
  }
  return warnings;
}

module.exports = { config, validateConfig, configWarnings };
