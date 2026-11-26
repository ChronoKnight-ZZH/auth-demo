'use strict';
/**
 * HTTPS 模式测试：应用自身终结 TLS（本地联调用；生产仍由 Nginx 终结 TLS）。
 *
 * 覆盖：
 *   1. /health 走 HTTPS 正常返回；
 *   2. TLS 端口不接受明文 HTTP（真正强制 TLS，不是「http 也开着」）；
 *   3. 登录下发的会话 Cookie 带 Secure / HttpOnly（与生产一致）；
 *   4. TLS_REDIRECT_HTTP_PORT 的 HTTP 端口 301 跳到 HTTPS。
 *
 * 运行：node test/tls.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { generateCert } = require('../scripts/gen-cert');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** HTTPS 请求（本地自签证书放行校验） */
function httpsRequest(port, urlPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          origin: `https://127.0.0.1:${port}`,
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 明文 HTTP 请求（用于验证 TLS 端口拒绝明文、跳转端口返回 301） */
function httpRequest(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

function encodeLogin(username, password) {
  const ub = Buffer.from(username, 'utf8');
  return Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'), ub, Buffer.from(password, 'utf8'),
  ]).toString('utf8');
}

/** 起一个 TLS 模式的服务进程，等到 /health 可用 */
async function startTlsServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-demo-tls-'));
  const certPath = path.join(tmp, 'tls_cert.pem');
  const keyPath = path.join(tmp, 'tls_key.pem');
  const { certPem, keyPem } = generateCert({ days: 1 });
  fs.writeFileSync(certPath, certPem);
  fs.writeFileSync(keyPath, keyPem);

  // 空 env 文件：跳过仓库 .env，强制内存后端
  const emptyEnv = path.join(tmp, 'empty.env');
  fs.writeFileSync(emptyEnv, '');

  // RSA 密钥缺失时先生成（服务端启动时读取）
  if (!fs.existsSync(path.join(ROOT, 'secrets', 'rsa_private.pem'))) {
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-keys.js')], { cwd: ROOT, stdio: 'ignore' });
  }

  const port = await freePort();
  const redirectPort = await freePort();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    ENV_FILE: emptyEnv,
    PEPPER: 'test-pepper-tls-0123456789abcdef',
    HOST: '127.0.0.1',
    PORT: String(port),
    TLS_ENABLED: '1',
    TLS_CERT_PATH: certPath,
    TLS_KEY_PATH: keyPath,
    TLS_REDIRECT_HTTP_PORT: String(redirectPort),
    FILES_DIR: path.join(tmp, 'files'),
  };
  delete env.MYSQL_URL;
  delete env.REDIS_URL;

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c.toString(); });
  child.stderr.on('data', (c) => { log += c.toString(); });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('服务进程提前退出：\n' + log);
    try {
      const res = await httpsRequest(port, '/health');
      if (res.status === 200) break;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('服务启动超时：\n' + log);
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    port,
    redirectPort,
    log: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

test('HTTPS 模式：应用自身终结 TLS', async (t) => {
  const server = await startTlsServer();
  try {
    await t.test('健康检查走 HTTPS 返回 200', async () => {
      const res = await httpsRequest(server.port, '/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
    });

    await t.test('TLS 端口拒绝明文 HTTP', async () => {
      await assert.rejects(() => httpRequest(server.port, '/health'));
    });

    await t.test('登录下发的会话 Cookie 带 Secure / HttpOnly', async () => {
      const pk = await httpsRequest(server.port, '/auth/public-key');
      assert.strictEqual(pk.status, 200);
      const encrypted = crypto.publicEncrypt(
        {
          key: pk.body.publicKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: pk.body.oaepHash,
        },
        Buffer.from(encodeLogin('alice', 'Alice@Passw0rd'), 'utf8')
      ).toString('base64');

      const login = await httpsRequest(server.port, '/auth/login', {
        method: 'POST',
        body: { encrypted },
      });
      assert.strictEqual(login.status, 200);
      const cookies = login.headers['set-cookie'] || [];
      assert.ok(cookies.length > 0, '登录应下发 Set-Cookie');
      assert.match(cookies[0], /HttpOnly/i);
      assert.match(cookies[0], /Secure/i);
    });

    await t.test('HTTP 跳转端口 301 指向 HTTPS', async () => {
      const res = await httpRequest(server.redirectPort, '/health');
      assert.strictEqual(res.status, 301);
      const location = res.headers.location;
      assert.ok(location.startsWith(`https://127.0.0.1:${server.port}/health`), location);
    });
  } finally {
    await server.stop();
  }
});
