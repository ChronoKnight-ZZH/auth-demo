'use strict';
/**
 * 服务器入口。启动失败时明确拒绝启动并给出原因（方案 A-B-03）。
 *
 * 传输层：
 *   - 默认 http.createServer（生产由 Nginx 终结 TLS，应用只监听回环）；
 *   - TLS_ENABLED=1 时改为 https.createServer（本地 HTTPS 联调）；
 *   - 可选 TLS_REDIRECT_HTTP_PORT > 0：额外起一个纯 HTTP 端口，301 跳到 HTTPS，
 *     用于在本地复现「HTTP→HTTPS 强制跳转」。
 */
require('./lib/fetch-global');
require('./lib/load-env').loadEnv();
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { createApp } = require('./app');
const { config } = require('./config');

/** 读取 TLS 证书材料；失败时抛出可读原因 */
function loadTlsOptions() {
  const options = {};
  try {
    options.cert = fs.readFileSync(config.tls.certPath);
  } catch (e) {
    throw new Error(`读取 TLS 证书失败 (${config.tls.certPath}): ${e.message}；先执行 npm run cert 生成自签名证书`);
  }
  try {
    options.key = fs.readFileSync(config.tls.keyPath);
  } catch (e) {
    throw new Error(`读取 TLS 私钥失败 (${config.tls.keyPath}): ${e.message}；先执行 npm run cert 生成自签名证书`);
  }
  if (config.tls.caPath) {
    try {
      options.ca = fs.readFileSync(config.tls.caPath);
    } catch (e) {
      throw new Error(`读取 TLS CA 失败 (${config.tls.caPath}): ${e.message}`);
    }
  }
  return options;
}

/** 纯 HTTP → HTTPS 301 跳转（本地模拟 Nginx 的强制跳转） */
function createRedirectServer() {
  return http.createServer((req, res) => {
    const hostHeader = String(req.headers.host || '').trim();
    const host = config.tls.redirectHost || hostHeader || `${config.host}:${config.port}`;
    const hostname = host.replace(/:\d+$/, '');
    const portPart = config.port === 443 ? '' : `:${config.port}`;
    res.writeHead(301, { Location: `https://${hostname}${portPart}${req.url}` });
    res.end();
  });
}

async function main() {
  let ctx;
  try {
    ctx = await createApp();
  } catch (e) {
    console.error('\n[启动失败] ' + e.message + '\n');
    process.exit(1);
  }

  const { app, userRepo, sessionStore, chatRepo, fileRepo, agentTaskRepo, agentQueue, backends } = ctx;

  const useTls = config.tls.enabled;
  const protocol = useTls ? 'https' : 'http';
  let server;
  if (useTls) {
    let tlsOptions;
    try {
      tlsOptions = loadTlsOptions();
    } catch (e) {
      console.error('\n[启动失败] ' + e.message + '\n');
      process.exit(1);
    }
    server = https.createServer(tlsOptions, app);
  } else {
    server = http.createServer(app);
  }

  // 可选：HTTP → HTTPS 跳转端口
  let redirectServer = null;
  if (useTls && config.tls.redirectHttpPort > 0) {
    redirectServer = createRedirectServer();
    redirectServer.on('error', (e) => {
      console.error(`[跳转端口] 监听 ${config.tls.redirectHttpPort} 失败: ${e.message}`);
    });
    redirectServer.listen(config.tls.redirectHttpPort, config.host);
  }

  server.on('error', (e) => {
    console.error(`\n[启动失败] 监听 ${config.host}:${config.port} 失败: ${e.message}\n`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log(`auth-demo 已启动  ${protocol}://${config.host}:${config.port}`);
    console.log(`  环境      : ${config.env}`);
    console.log(`  传输      : ${useTls ? 'HTTPS（应用内终结 TLS）' : 'HTTP（Nginx 反代模式）'}`);
    if (useTls) {
      console.log(`  证书      : ${config.tls.certPath}`);
      console.log(`  私钥      : ${config.tls.keyPath}`);
      console.log('  提示      : 本地自签名证书浏览器会告警，需手动信任或临时放行');
    }
    if (redirectServer) {
      console.log(`  HTTP 跳转 : http://${config.host}:${config.tls.redirectHttpPort} → ${protocol}://${config.host}:${config.port}`);
    }
    console.log(`  用户存储  : ${backends.user}`);
    console.log(`  会话存储  : ${backends.session}`);
    console.log(`  聊天存储  : ${backends.chat}`);
    console.log(`  附件存储  : ${backends.files}${config.files.mode === 'local' ? ` (${config.files.dir})` : ''}`);
    console.log(`  Agent     : ${config.agent.enabled ? 'enabled' : 'disabled'} (queue=${config.agent.queueMode}, executor=${config.agent.executionEnabled ? 'on' : 'off'})`);
    console.log(`  RSA       : OAEP / ${config.rsa.oaepHash} / 上限 ${config.rsa.maxPlaintextBytes}B`);
    console.log(`  Argon2id  : m=${config.argon2.memoryCost} t=${config.argon2.timeCost} p=${config.argon2.parallelism}`);
    console.log(`  会话 TTL  : 空闲 ${config.session.idleMs / 60000}min / 绝对 ${config.session.absoluteMs / 86400000}d`);
    console.log(`  限流      : account ${config.login.maxPerAccount} / ip ${config.login.maxPerIp} per ${config.login.windowSec}s`);
    console.log(`  Cookie    : Secure=${config.cookie.secure} SameSite=${config.cookie.sameSite}`);
  });

  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭...`);
    server.close();
    redirectServer?.close();
    await sessionStore.close().catch(() => {});
    await userRepo.close().catch(() => {});
    await chatRepo.close().catch(() => {});
    await fileRepo?.close().catch(() => {});
    await agentQueue?.close().catch(() => {});
    await agentTaskRepo?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
