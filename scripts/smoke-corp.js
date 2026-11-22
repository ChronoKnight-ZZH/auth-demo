'use strict';
/**
 * 分域部署集成检查：内存后端 + CORS_ORIGINS 场景下，
 * 登录 → 上传原件 → 换票 → 读取 content 全链路的 CORS/CORP 头。
 * 用法：node scripts/smoke-corp.js（独立内存环境，不碰 MySQL/Redis）
 */
process.env.NODE_ENV = 'production';
process.env.PEPPER = 'corp-smoke-pepper-0123456789';
process.env.MYSQL_URL = ''; // 强制内存后端，避免触碰真实数据库
process.env.REDIS_URL = '';
process.env.FILE_TOKEN_SECRET = 'corp-smoke-secret';
process.env.CORS_ORIGINS = 'https://chat.shunkai-dg.cn';
process.env.FILES_MODE = 'local';
process.env.PORT = '3111';
process.env.HOST = '127.0.0.1';

const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const BASE = 'http://127.0.0.1:3111';
const CHAT = 'https://chat.shunkai-dg.cn';
let pubKey = null;
let oaepHash = 'sha256';

function encryptLogin(username, password) {
  const ub = Buffer.from(username, 'utf8');
  const plain = Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'),
    ub,
    Buffer.from(password, 'utf8'),
  ]).toString('utf8');
  return crypto
    .publicEncrypt(
      { key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
      Buffer.from(plain, 'utf8')
    )
    .toString('base64');
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function main() {
  const ctx = await createApp();
  const server = ctx.app.listen(3111, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const pk = await (await fetch(BASE + '/auth/public-key')).json();
    pubKey = pk.publicKey;
    oaepHash = pk.oaepHash;

    const login = await fetch(BASE + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: CHAT },
      body: JSON.stringify({ encrypted: encryptLogin('alice', 'Alice@Passw0rd') }),
    });
    check('分域登录成功且回 CORS 头', login.status === 200 &&
      login.headers.get('access-control-allow-origin') === CHAT &&
      login.headers.get('access-control-allow-credentials') === 'true',
      `status=${login.status}`);
    const token = (await login.json()).token;

    // 建一个会话：/auth/me 拿 userId，直接落内存 chatRepo（等价于业务侧保存会话）
    const me = await (
      await fetch(BASE + '/auth/me', { headers: { authorization: `Bearer ${token}` } })
    ).json();
    const userId = me.userId;
    const session = await ctx.chatRepo.saveSession(userId, {
      id: 'corp-smoke-session',
      title: 'corp smoke',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    });
    const sessionId = session && session.id;
    check('获得会话 id', Boolean(sessionId), String(sessionId));

    // 上传原件（1x1 PNG）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const up = await fetch(BASE + '/v1/files/originals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'image/png',
        'x-file-name': encodeURIComponent('a.png'),
        'x-file-mime': 'image/png',
      },
      body: png,
    });
    const upJson = await up.json().catch(() => ({}));
    check('上传原件成功（含自定义头预检语义）', (up.status === 200 || up.status === 201) && upJson.fileId, `status=${up.status}`);

    const urlRes = await fetch(
      `${BASE}/v1/files/originals/${upJson.fileId}/url?sessionId=${sessionId}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const urlSet = await urlRes.json().catch(() => ({}));
    check('换票成功', urlRes.status === 200 && urlSet.urls && urlSet.urls.p, `status=${urlRes.status}`);

    // <img> 风格读取：无 Origin（真实 <img> 对同源资源不带 Origin，跨站才带）
    const content = await fetch(
      `${BASE}/v1/files/content?file_id=${upJson.fileId}&state=${encodeURIComponent(urlSet.urls.p)}&ty=p`
    );
    check('content 读取 200', content.status === 200, `status=${content.status}`);
    check(
      'content CORP = same-site（分域自动降级，chat.X 能内嵌 api.X 图片）',
      content.headers.get('cross-origin-resource-policy') === 'same-site',
      `corp=${content.headers.get('cross-origin-resource-policy')}`
    );

    // 浏览器跨站 <img> 会带 Origin: null 或不带；这里再验一条带白名单 Origin 的 fetch
    const content2 = await fetch(
      `${BASE}/v1/files/content?file_id=${upJson.fileId}&state=${encodeURIComponent(urlSet.urls.p)}&ty=p`,
      { headers: { Origin: CHAT } }
    );
    check(
      '带白名单 Origin 的 content 同时具备 CORS 头',
      content2.headers.get('access-control-allow-origin') === CHAT,
      `aco=${content2.headers.get('access-control-allow-origin')}`
    );
  } finally {
    server.close();
    await ctx.sessionStore.close().catch(() => {});
    await ctx.userRepo.close().catch(() => {});
    await ctx.chatRepo.close().catch(() => {});
    await ctx.fileRepo?.close().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('集成检查异常:', e);
  process.exit(1);
});
