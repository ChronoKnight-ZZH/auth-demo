'use strict';
/**
 * 服务器入口。启动失败时明确拒绝启动并给出原因（方案 A-B-03）。
 */
require('./lib/load-env').loadEnv();
const { createApp } = require('./app');
const { config } = require('./config');

async function main() {
  let ctx;
  try {
    ctx = await createApp();
  } catch (e) {
    console.error('\n[启动失败] ' + e.message + '\n');
    process.exit(1);
  }

  const { app, userRepo, sessionStore, backends } = ctx;

  const server = app.listen(config.port, config.host, () => {
    console.log(`auth-demo 已启动  http://${config.host}:${config.port}`);
    console.log(`  环境      : ${config.env}`);
    console.log(`  用户存储  : ${backends.user}`);
    console.log(`  会话存储  : ${backends.session}`);
    console.log(`  RSA       : OAEP / ${config.rsa.oaepHash} / 上限 ${config.rsa.maxPlaintextBytes}B`);
    console.log(`  Argon2id  : m=${config.argon2.memoryCost} t=${config.argon2.timeCost} p=${config.argon2.parallelism}`);
    console.log(`  会话 TTL  : 空闲 ${config.session.idleMs / 60000}min / 绝对 ${config.session.absoluteMs / 86400000}d`);
    console.log(`  限流      : account ${config.login.maxPerAccount} / ip ${config.login.maxPerIp} per ${config.login.windowSec}s`);
  });

  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭...`);
    server.close();
    await sessionStore.close().catch(() => {});
    await userRepo.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();