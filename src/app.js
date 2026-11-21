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
const { createAuthenticate } = require('./middleware/authenticate');
const { createAuthService } = require('./services/auth-service');
const { createRoutes } = require('./routes/auth');
const { createChatRoutes } = require('./routes/chat');
const { CircuitBreaker } = require('./lib/circuit-breaker');
const { RelayService } = require('./stream/relay-service');
const { warmup, hashPassword } = require('./crypto/password');

async function buildStores() {
  const useMysql = Boolean(config.mysql.url);
  const useRedis = Boolean(config.redis.url);

  let userRepo, sessionStore;
  if (useMysql) {
    const { MysqlUserRepo } = require('./db/mysql-user-repo');
    userRepo = new MysqlUserRepo();
  } else {
    const { MemoryUserRepo } = require('./db/memory-user-repo');
    userRepo = new MemoryUserRepo();
  }
  if (useRedis) {
    const { RedisSessionStore } = require('./session/redis-store');
    sessionStore = new RedisSessionStore();
  } else {
    const { MemorySessionStore } = require('./session/memory-store');
    sessionStore = new MemorySessionStore();
  }
  return { userRepo, sessionStore, backends: { user: useMysql ? 'mysql' : 'memory', session: useRedis ? 'redis' : 'memory' } };
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

  const { userRepo, sessionStore, backends } = await buildStores();

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

  // 全局 16kb：登录密文只有数百字节，收紧默认面；
  // /v1 中转单独放宽到 CHAT_BODY_LIMIT（express.json 先到先得，故按路径跳过全局解析）
  app.use((req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    return express.json({ limit: config.bodyLimit })(req, res, next);
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      backends: { ...backends, stream: bufferKind },
      userStoreVersion,
      env: config.env,
      relay: {
        upstream: config.upstream.baseUrl,
        upstreamConfigured: Boolean(config.upstream.apiKey),
        cache: config.cache.enabled ? (config.redis.url ? 'redis' : 'memory') : 'off',
        ...relay.stats(),
      },
    });
  });

  app.use('/auth', createRoutes({ authService, authenticate }));
  app.use('/v1', createChatRoutes({ relay, authenticate }));

  // 静态登录页（在 404 兜底之前挂载，否则永不命中）
  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND', message: '资源不存在' }));
  app.use(errorHandler);

  return { app, userRepo, sessionStore, buffer, cache, relay, backends: { ...backends, stream: bufferKind }, limiter };
}

module.exports = { createApp };
