'use strict';
/**
 * 一键拉起本地两服务：被测后端 + 测试上游 API。
 *
 *   npm run dev:local                              # 复读机上游 :8788（能看清请求是否真的到达上游）
 *   npm run dev:local -- --mock                    # 固定 tok0 tok1… 的 mock 上游 :8787
 *   npm run dev:local -- --memory                  # 忽略 .env 的 MySQL/Redis，纯内存后端
 *   npm run dev:local -- --https                   # 后端改用 https（自签证书，缺证书自动生成）
 *   npm run dev:local -- --agent                   # 开启 Agent：inline 队列，任务在本进程内消费
 *   npm run dev:local -- --port 4000 --upstream-port 8899
 *   npm run dev:local -- --host 0.0.0.0            # 局域网访问
 *
 * 做的事：
 *   1. 缺 RSA 密钥时自动执行 scripts/gen-keys.js；
 *   2. 未配置 PEPPER 时注入开发用默认值（只进子进程环境，不写文件）；
 *   3. 先起测试上游，健康检查通过后再起后端，并把 UPSTREAM_BASE_URL 指向它；
 *   4. 两个进程日志加 [api]/[app] 前缀汇总到当前终端；
 *   5. 任一进程退出即整体退出；Ctrl+C 一起停掉。
 *
 * 存储后端默认沿用 .env（MYSQL_URL / REDIS_URL 留空 = 内存实现，自动种 alice / bob）；
 * 加 --memory 可强制内存后端，无视 .env，适合本机没有 MySQL/Redis 的场景。
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const ROOT = path.join(__dirname, '..');
const DEV_PEPPER = 'dev-pepper-local-only-do-not-use-in-production';
const LOCAL_API_KEY = 'sk-local-dev-placeholder';

let values;
try {
  ({ values } = parseArgs({
    options: {
      mock: { type: 'boolean', default: false },
      memory: { type: 'boolean', default: false },
      https: { type: 'boolean', default: false },
      agent: { type: 'boolean', default: false },
      port: { type: 'string' },
      'upstream-port': { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  console.error(error.message);
  console.error('用法：npm run dev:local -- [--mock] [--memory] [--https] [--agent] [--port 3000] [--upstream-port 8788] [--host 127.0.0.1]');
  process.exit(2);
}

if (values.help) {
  console.log(`用法：npm run dev:local -- [选项]

选项：
  --mock                 使用 mock-upstream（固定 tok0 tok1…）而非复读机
  --memory               强制内存后端（忽略 .env 的 MySQL/Redis，零依赖）
  --https                后端启用 HTTPS（自动生成自签名证书到 secrets/）
  --agent                开启 Agent：AGENT_ENABLED=1 + inline 队列（本进程消费任务）
  --port <n>             后端端口，默认 3000
  --upstream-port <n>    测试上游端口，默认 mock=8787 / echo=8788
  --host <h>             后端监听地址，默认 127.0.0.1
  -h, --help             显示帮助`);
  process.exit(0);
}

function portOf(raw, def, name) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    console.error(`${name} 不是合法端口: ${raw}`);
    process.exit(2);
  }
  return n;
}

const APP_PORT = portOf(values.port, 3000, '--port');
const UPSTREAM_PORT = portOf(values['upstream-port'], values.mock ? 8787 : 8788, '--upstream-port');
const HOST = values.host || '127.0.0.1';
const USE_TLS = Boolean(values.https);
const APP_PROTOCOL = USE_TLS ? 'https' : 'http';
const APP_URL = `${APP_PROTOCOL}://127.0.0.1:${APP_PORT}`;
const UPSTREAM_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
const UPSTREAM_SCRIPT = values.mock ? 'mock-upstream.js' : 'echo-upstream.js';
const UPSTREAM_NAME = values.mock ? 'mock 上游' : '本地复读机';
const TLS_CERT = path.join(ROOT, 'secrets', 'tls_cert.pem');
const TLS_KEY = path.join(ROOT, 'secrets', 'tls_key.pem');

/** .env 里是否显式配置了某项（load-env 不覆盖已存在的环境变量，故需先看一眼） */
function envFileHas(key, file = process.env.ENV_FILE || path.join(ROOT, '.env')) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      if (line.slice(0, eq).trim() !== key) continue;
      return line.slice(eq + 1).trim() !== '';
    }
  } catch { /* 没有 .env 视为未配置 */ }
  return false;
}

function ensureKeys() {
  const priv = path.join(ROOT, 'secrets', 'rsa_private.pem');
  if (fs.existsSync(priv)) return;
  console.log('[dev] 未找到 RSA 密钥，先生成一对…');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-keys.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0 || !fs.existsSync(priv)) {
    console.error('[dev] 生成 RSA 密钥失败，请先执行 npm run keys');
    process.exit(1);
  }
}

/** --https：缺自签名证书时自动生成（secrets/tls_cert.pem + secrets/tls_key.pem） */
function ensureCert() {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) return;
  console.log('[dev] 未找到 TLS 自签名证书，先生成一对…');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-cert.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0 || !fs.existsSync(TLS_CERT) || !fs.existsSync(TLS_KEY)) {
    console.error('[dev] 生成 TLS 证书失败，请先执行 npm run cert');
    process.exit(1);
  }
}

/** 起一个子进程，日志按 [tag] 前缀汇总；返回句柄供退出/清理使用 */
function spawnPrefixed(scriptPath, args, env, tag) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle = { child, tag, tail: [] };
  const label = `[${tag}]`;
  const pump = (stream) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      rest += chunk;
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        console.log(`${label} ${line}`);
        handle.tail.push(line);
        if (handle.tail.length > 200) handle.tail.shift();
      }
    });
    stream.on('end', () => {
      if (rest) {
        console.log(`${label} ${rest}`);
        handle.tail.push(rest);
      }
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${tag} 意外退出（code=${code}${signal ? `, signal=${signal}` : ''}）`);
    shutdown(code === 0 || code === null ? 1 : code);
  });
  return handle;
}

/**
 * 探测 URL 是否可达（<500 视为已响应）。
 * https + 本地自签证书时忽略证书校验（Node 的 https.request 单独控制，不影响全局）。
 */
function isUp(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** 读 JSON（https 自签证书同样放行） */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

async function waitFor(url, timeoutMs, proc) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await isUp(url)) return true;
    if (proc && proc.child.exitCode !== null) return false;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

const children = [];
let shuttingDown = false;
let emptyEnvFile = null;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev] 正在停止两个服务…');
  for (const p of children) killTree(p.child);
  if (emptyEnvFile) {
    try { fs.rmSync(emptyEnvFile, { force: true }); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function fail(message, proc) {
  console.error(`\n[dev] ${message}`);
  if (proc && proc.tail.length) {
    console.error(`[dev] ${proc.tag} 最近输出：`);
    for (const line of proc.tail.slice(-20)) console.error(`    ${line}`);
  }
  shutdown(1);
}

async function main() {
  ensureKeys();
  if (USE_TLS) ensureCert();

  // 端口占用先查，避免两个进程抢同一个口后互相误导
  if (await isUp(`${UPSTREAM_URL}/health`)) {
    console.error(`[dev] 端口 ${UPSTREAM_PORT} 已有服务在响应，先停掉它或换 --upstream-port`);
    process.exit(1);
  }
  if (await isUp(`${APP_URL}/health`)) {
    console.error(`[dev] 端口 ${APP_PORT} 已有服务在响应，先停掉它或换 --port`);
    process.exit(1);
  }

  // ---- 1. 测试上游 ----
  const upstreamProc = spawnPrefixed(
    path.join(ROOT, 'scripts', UPSTREAM_SCRIPT),
    [String(UPSTREAM_PORT)],
    { ...process.env },
    'api'
  );
  children.push(upstreamProc);
  if (!await waitFor(`${UPSTREAM_URL}/health`, 15_000, upstreamProc)) {
    return fail(`${UPSTREAM_NAME} 启动失败（端口 ${UPSTREAM_PORT}）`, upstreamProc);
  }

  // ---- 2. 被测后端 ----
  const serverEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'development',
    HOST,
    PORT: String(APP_PORT),
    /** 关键：把上游指到本地测试 API，业务代码零改动 */
    UPSTREAM_BASE_URL: UPSTREAM_URL,
    UPSTREAM_API_KEY: LOCAL_API_KEY,
  };
  if (USE_TLS) {
    /** 本地 HTTPS：应用内终结 TLS，证书为本地自签名（浏览器需手动信任） */
    serverEnv.TLS_ENABLED = '1';
    serverEnv.TLS_CERT_PATH = TLS_CERT;
    serverEnv.TLS_KEY_PATH = TLS_KEY;
    // 会话 Cookie 打上 Secure，与生产（TLS 终结后）行为一致
    serverEnv.SESSION_COOKIE_SECURE = '1';
    console.log('[dev] --https：后端启用 HTTPS（自签名证书，浏览器需信任）');
  }
  if (values.agent) {
    /**
     * 本地 Agent：inline 队列由 API 进程自己消费，省掉独立 Worker 与 Redis 依赖。
     * 阶段 1 的执行器是占位实现，任务会立刻落 failed + AGENT_EXECUTOR_UNAVAILABLE，
     * 但 queued→running→终态 的全链路（含前端轮询）都能真实跑通。
     */
    serverEnv.AGENT_ENABLED = '1';
    serverEnv.AGENT_QUEUE_MODE = 'inline';
    serverEnv.AGENT_EXECUTION_ENABLED = '1';
    console.log('[dev] --agent：Agent 已开启（inline 队列，本进程消费任务）');
  }
  if (values.memory) {
    // 指向空文件：让 load-env 完全跳过 .env，避免其中的 MYSQL_URL/REDIS_URL 生效
    // 先清掉上一次被强杀残留的空配置文件
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('auth-demo-memory-') && name.endsWith('.env')) {
        try { fs.rmSync(path.join(os.tmpdir(), name), { force: true }); } catch { /* ignore */ }
      }
    }
    emptyEnvFile = path.join(os.tmpdir(), `auth-demo-memory-${process.pid}.env`);
    fs.writeFileSync(emptyEnvFile, '');
    serverEnv.ENV_FILE = emptyEnvFile;
    delete serverEnv.MYSQL_URL;
    delete serverEnv.REDIS_URL;
    console.log('[dev] --memory：强制内存后端（忽略 .env 中的 MySQL/Redis）');
  }
  if (!process.env.PEPPER && !envFileHas('PEPPER', values.memory ? emptyEnvFile : undefined)) {
    serverEnv.PEPPER = DEV_PEPPER;
    console.log('[dev] 未配置 PEPPER，已为本次运行注入开发默认值（不写入 .env）');
  }

  const appProc = spawnPrefixed(path.join(ROOT, 'src', 'server.js'), [], serverEnv, 'app');
  children.push(appProc);

  if (!await waitFor(`${APP_URL}/health`, 40_000, appProc)) {
    return fail(`后端启动失败（端口 ${APP_PORT}）`, appProc);
  }

  // ---- 3. 概要 ----
  let health = null;
  try { health = await getJson(`${APP_URL}/health`); } catch { /* ignore */ }

  console.log('');
  console.log('============================================================');
  console.log(' 两个服务已启动（Ctrl+C 停止）');
  console.log('------------------------------------------------------------');
  console.log(`  被测服务   ${APP_URL}`);
  console.log(`             登录页    ${APP_URL}/`);
  console.log(`             健康检查  ${APP_URL}/health`);
  console.log(`  测试上游   ${UPSTREAM_URL}  （${UPSTREAM_NAME}）`);
  console.log(`             观测入参  ${UPSTREAM_URL}/__calls`);
  if (!values.mock) console.log(`             测试台    ${UPSTREAM_URL}/`);
  if (USE_TLS) {
    console.log('  TLS 证书   ' + TLS_CERT);
    console.log('             浏览器首次访问会告警「不安全」，需在证书详情里手动信任；');
    console.log('             curl 需加 -k（Node 脚本设 TLS_INSECURE=1 放行自签证书）');
  }
  if (health) {
    const b = health.backends || {};
    console.log(`  存储后端   用户=${b.user} 会话=${b.session} 聊天=${b.chat} 附件=${b.files}`);
    console.log(`  上游地址   ${health.relay && health.relay.upstream}`);
    if (b.user === 'memory') {
      console.log('  登录账号   alice / Alice@Passw0rd   bob / Bob@Passw0rd（内存库自动种子）');
    } else {
      console.log('  登录账号   来自 MySQL，用库中已有账号（npm run user:list 查看）');
    }
  }
  console.log('  curl 提示  状态变更请求需带 Origin（CSRF）：');
  console.log(`             -H "Origin: ${APP_URL}"`);
  console.log('============================================================');
  console.log('');
}

main().catch((error) => {
  console.error('[dev] 启动异常：' + error.message);
  shutdown(1);
});
