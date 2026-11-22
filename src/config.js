'use strict';
/**
 * 统一配置。所有可调数值集中在此，对应方案 §4、§6.3、§10。
 * 环境变量优先，缺省值即方案定稿的默认值。
 */
const crypto = require('node:crypto');
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

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 3000),
  host: process.env.HOST || '127.0.0.1', // 方案 §6.5：只监听回环，由 Nginx 终结 TLS
  trustProxy: bool('TRUST_PROXY', true),

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
  return warnings;
}

module.exports = { config, validateConfig, configWarnings };
