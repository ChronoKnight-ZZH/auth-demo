'use strict';
/**
 * 应用装配：存储后端选择、启动自检、中间件链、中转链路。
 * 对应方案 §6.5、A-B-03。
 */
const express = require('express');
const path = require('node:path');
const { config, validateConfig, configWarnings } = require('./config');
const { errorHandler } = require('./lib/errors');
const { createRateLimiter } = require('./lib/rate-limiter');
const { createCors } = require('./middleware/cors');
const { createCookieParser } = require('./middleware/cookie-parser');
const { createCsrf } = require('./middleware/csrf');
const { createAuthenticate } = require('./middleware/authenticate');
const { createAuthService } = require('./services/auth-service');
const { createRoutes } = require('./routes/auth');
const { createChatRoutes } = require('./routes/chat');
const { createProxyRoutes } = require('./routes/proxy');
const { createSessionRoutes } = require('./routes/sessions');
const { createFileRoutes } = require('./routes/file-storage');
const { CircuitBreaker } = require('./lib/circuit-breaker');
const { RelayService } = require('./stream/relay-service');
const { warmup, hashPassword } = require('./crypto/password');
const { diskInfo, processInfo } = require('./lib/system-info');

async function buildStores() {
  const useMysql = Boolean(config.mysql.url);
  const useRedis = Boolean(config.redis.url);

  let userRepo, sessionStore, chatRepo, fileRepo;
  if (useMysql) {
    const { MysqlUserRepo } = require('./db/mysql-user-repo');
    const { MysqlChatRepo } = require('./db/mysql-chat-repo');
    const { MysqlFileRepo } = require('./db/mysql-file-repo');
    userRepo = new MysqlUserRepo();
    chatRepo = new MysqlChatRepo();
    fileRepo = config.files.mode === 'local' ? new MysqlFileRepo() : null;
  } else {
    const { MemoryUserRepo } = require('./db/memory-user-repo');
    const { MemoryChatRepo } = require('./db/memory-chat-repo');
    const { MemoryFileRepo } = require('./db/memory-file-repo');
    userRepo = new MemoryUserRepo();
    chatRepo = new MemoryChatRepo();
    fileRepo = config.files.mode === 'local' ? new MemoryFileRepo() : null;
  }
  if (useRedis) {
    const { RedisSessionStore } = require('./session/redis-store');
    sessionStore = new RedisSessionStore();
  } else {
    const { MemorySessionStore } = require('./session/memory-store');
    sessionStore = new MemorySessionStore();
  }
  return {
    userRepo,
    sessionStore,
    chatRepo,
    fileRepo,
    backends: {
      user: useMysql ? 'mysql' : 'memory',
      session: useRedis ? 'redis' : 'memory',
      chat: useMysql ? 'mysql' : 'memory',
      files: config.files.mode === 'local' ? (useMysql ? 'mysql+disk' : 'memory+disk') : 'off',
    },
  };
}

/** 事件缓冲：与 SessionStore 同构 —— Redis 优先，缺 Redis 自动降级内存（A-U-03 双实现） */
function buildEventBuffer(useRedis) {
  if (useRedis) {
    const { RedisStreamBuffer } = require('./stream/redis-buffer');
    return { buffer: new RedisStreamBuffer(), kind: 'redis' };
  }
  const { MemoryEventBuffer } = require('./stream/memory-buffer');
  return { buffer: new MemoryEventBuffer(), kind: 'memory' };
}

async function createApp() {
  const errors = validateConfig();
  if (errors.length) {
    throw new Error('配置自检失败:\n  - ' + errors.join('\n  - '));
  }
  for (const w of configWarnings()) console.warn('[配置提示] ' + w);

  const { userRepo, sessionStore, chatRepo, fileRepo, backends } = await buildStores();

  // 启动自检：存储连通性（A-B-03）
  let userStoreVersion;
  try {
    userStoreVersion = await userRepo.ping();
  } catch (e) {
    throw new Error(`用户存储连接失败: ${e.message}`);
  }
  try {
    await sessionStore.ping();
  } catch (e) {
    throw new Error(`会话存储连接失败: ${e.message}`);
  }
  try {
    await chatRepo.ping();
  } catch (e) {
    throw new Error(`聊天存储连接失败: ${e.message}`);
  }
  if (fileRepo) {
    try {
      await fileRepo.ping();
      await require('./files/blob-store').init();
    } catch (e) {
      throw new Error(`文件存储初始化失败: ${e.message}`);
    }
  }

  const { buffer, kind: bufferKind } = buildEventBuffer(Boolean(config.redis.url));
  try {
    await buffer.ping();
  } catch (e) {
    throw new Error(`事件缓冲连接失败: ${e.message}`);
  }
  const cache = config.cache.enabled
    ? require('./stream/cache').createResponseCache(Boolean(config.redis.url))
    : null;
  if (cache) {
    try { await cache.redis?.ping(); } catch (e) { throw new Error(`响应缓存连接失败: ${e.message}`); }
  }

  // 内存后端自动写入种子用户，保证开箱可登录
  if (backends.user === 'memory') {
    const seeds = [
      { username: 'alice', password: 'Alice@Passw0rd' },
      { username: 'bob', password: 'Bob@Passw0rd' },
    ];
    const rows = [];
    for (const s of seeds) {
      rows.push({ username: s.username, passwordHash: await hashPassword(s.password) });
    }
    await userRepo.seed(rows);
  }

  // dummy hash 预热：避免重启后首个「用户不存在」请求付两次 Argon2
  await warmup();

  const limiter = createRateLimiter(config.login);
  const authService = createAuthService({ userRepo, sessionStore, limiter });
  const authenticate = createAuthenticate(sessionStore);
  const relay = new RelayService({ buffer, cache, breaker: new CircuitBreaker() });

  const app = express();
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  // 分域部署（前端 chat. 直连本站 api.）时按白名单放行跨域；
  // CORS_ORIGINS 留空 = 同源反代，中间件退化为直通，不影响任何现有行为。
  // 必须在 body 解析与鉴权之前：预检 OPTIONS 不带 Authorization，也不能被 JSON 解析拦住。
  app.use(createCors(config.cors));

  // Cookie 解析先于所有路由：鉴权中间件从 req.cookies 取会话 token。
  app.use(createCookieParser());
  // CSRF：会话改走 HttpOnly Cookie 后，状态变更请求必须校验 Origin/Referer 白名单。
  app.use(createCsrf({ origins: config.cors.origins, enabled: config.cookie.csrfEnabled }));

  // 全局 16kb：登录密文只有数百字节，收紧默认面；
  // /v1 中转单独放宽到 CHAT_BODY_LIMIT（express.json 先到先得，故按路径跳过全局解析）
  app.use((req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    return express.json({ limit: config.bodyLimit })(req, res, next);
  });

  app.get('/health', async (req, res) => {
    const filesDisk = config.files.mode === 'local'
      ? await diskInfo(config.files.dir)
      : null;
    res.json({
      ok: true,
      backends: { ...backends, stream: bufferKind },
      userStoreVersion,
      env: config.env,
      files: {
        mode: config.files.mode,
        dedupe: config.files.dedupeScope,
        maxBytes: config.files.maxBytes,
        disk: filesDisk,
      },
      process: processInfo(),
      relay: {
        upstream: config.upstream.baseUrl,
        upstreamConfigured: Boolean(config.upstream.apiKey),
        cache: config.cache.enabled ? (config.redis.url ? 'redis' : 'memory') : 'off',
        ...relay.stats(),
      },
    });
  });

  app.use('/auth', createRoutes({ authService, authenticate }));
  // 原件路由必须先于其他 /v1 路由：/files/content 靠票据鉴权，不能先被
  // 会话路由的 router.use(authenticate) 拦成 TOKEN_MISSING
  if (fileRepo) {
    app.use('/v1', createFileRoutes({ fileRepo, chatRepo, authenticate }));
  }
  app.use('/v1', createSessionRoutes({ chatRepo, authenticate, fileRepo }));
  app.use('/v1', createChatRoutes({ relay, authenticate }));
  app.use('/v1', createProxyRoutes({ authenticate }));

  // 静态登录页（在 404 兜底之前挂载，否则永不命中）
  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND', message: '资源不存在' }));
  app.use(errorHandler);

  return { app, userRepo, sessionStore, chatRepo, fileRepo, buffer, cache, relay, backends: { ...backends, stream: bufferKind }, limiter };
}

module.exports = { createApp };
