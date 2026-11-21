'use strict';
/**
 * 演示/验收客户端：模拟前端用公钥加密后调用接口。
 * 用法：node scripts/smoke.js [baseUrl]
 */
const crypto = require('node:crypto');
const { loadEnv } = require('../src/lib/load-env');
loadEnv();

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

let pubKeyPem = null;
let pubKeyMeta = null;

function encrypt(plaintext) {
  return crypto.publicEncrypt(
    { key: pubKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: pubKeyMeta.oaepHash },
    Buffer.from(plaintext, 'utf8')
  ).toString('base64');
}

function encodeLogin(username, password) {
  const ub = Buffer.from(username, 'utf8');
  return Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'), ub, Buffer.from(password, 'utf8'),
  ]).toString('utf8');
}

function encodeChange(username, oldPassword, newPassword) {
  const ub = Buffer.from(username, 'utf8');
  const ob = Buffer.from(oldPassword, 'utf8');
  return Buffer.concat([
    Buffer.from(`v2\n${ub.length}\n`, 'utf8'), ub,
    Buffer.from(`${ob.length}\n`, 'utf8'), ob,
    Buffer.from(newPassword, 'utf8'),
  ]).toString('utf8');
}

async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body: json };
}

async function login(username, password) {
  return call('POST', '/auth/login', {
    body: { encrypted: encrypt(encodeLogin(username, password)) },
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function main() {
  console.log(`目标：${BASE}\n`);

  // ---- 健康检查 ----
  const health = await call('GET', '/health');
  check('健康检查返回 200', health.status === 200, JSON.stringify(health.body && health.body.backends));

  // ---- 公钥 ----
  const pk = await call('GET', '/auth/public-key');
  check('GET /auth/public-key 返回 200', pk.status === 200);
  check('公钥为 OAEP-SHA256 且上限 190', pk.body && pk.body.oaepHash === 'sha256' && pk.body.maxPlaintextBytes === 190,
    pk.body && `${pk.body.algorithm}/${pk.body.oaepHash}/${pk.body.maxPlaintextBytes}B`);
  pubKeyPem = pk.body.publicKey;
  pubKeyMeta = pk.body;

  // ---- A-F-01 正常登录 ----
  const ok = await login('alice', 'Alice@Passw0rd');
  check('A-F-01 正确账号密码登录成功', ok.status === 200 && ok.body && ok.body.token, `status=${ok.status}`);
  const token = ok.body && ok.body.token;

  // ---- A-F-02 凭证验证 ----
  const me = await call('GET', '/auth/me', { token });
  check('A-F-02 /auth/me 返回 200 且 userId 存在',
    me.status === 200 && typeof me.body.userId !== 'undefined', JSON.stringify(me.body));

  // ---- A-E-02 账号不存在与密码错误响应一致 ----
  const wrong = await login('alice', 'WrongPassword1');
  const noUser = await login('nobody', 'Whatever123');
  check('A-E-02 密码错误与账号不存在响应一致',
    wrong.status === 401 && noUser.status === 401 &&
    JSON.stringify(wrong.body) === JSON.stringify(noUser.body),
    `${wrong.status}/${JSON.stringify(wrong.body)}`);

  // ---- A-E-09 非法密文折叠为同一 401 ----
  const bad = await call('POST', '/auth/login', { body: { encrypted: 'AAAA' + 'B'.repeat(340) } });
  check('A-E-01 非法密文折叠为 401 且不含 DECRYPT_FAILED',
    bad.status === 401 && bad.body.code !== 'DECRYPT_FAILED', `${bad.status} ${bad.body && bad.body.code}`);

  // ---- A-E-03 Token 缺失 / 无效 ----
  const noTok = await call('GET', '/auth/me');
  check('A-E-03 无 Token → 401 TOKEN_MISSING',
    noTok.status === 401 && noTok.body.code === 'TOKEN_MISSING');
  const fakeTok = await call('GET', '/auth/me', { token: 'nonexistent-token-value' });
  check('A-E-03 未知 Token → 401 TOKEN_INVALID',
    fakeTok.status === 401 && fakeTok.body.code === 'TOKEN_INVALID');

  // ---- A-F-04 Redis/内存中不存 Token 原文（由后端断言，前端仅提示）----
  console.log('  INFO  A-F-04 需在后端存储侧核验，见 test/acceptance.test.js');

  // ---- A-E-05 登出后失效 ----
  const out = await call('POST', '/auth/logout', { token });
  check('A-E-05 登出返回 200', out.status === 200);
  const afterOut = await call('GET', '/auth/me', { token });
  check('A-E-05 登出后原 Token 失效', afterOut.status === 401, `${afterOut.status} ${afterOut.body && afterOut.body.code}`);

  // ---- A-E-06 改密撤销全部会话 ----
  const s1 = await login('bob', 'Bob@Passw0rd');
  const tok1 = s1.body.token;
  const s2 = await login('bob', 'Bob@Passw0rd');
  const tok2 = s2.body.token;
  check('A-E-06 同一用户可多 Session 并存',
    tok1 && tok2 && (await call('GET', '/auth/me', { token: tok2 })).status === 200);

  const changed = await call('POST', '/auth/change-password', {
    token: tok1,
    body: { encrypted: encrypt(encodeChange('bob', 'Bob@Passw0rd', 'Bob@NewPassw0rd')) },
  });
  check('A-E-06 改密请求成功', changed.status === 200, JSON.stringify(changed.body));

  const afterTok1 = await call('GET', '/auth/me', { token: tok1 });
  const afterTok2 = await call('GET', '/auth/me', { token: tok2 });
  check('A-E-06 改密后全部旧会话失效',
    afterTok1.status === 401 && afterTok2.status === 401,
    `${afterTok1.status}/${afterTok2.status}`);

  // ---- 新密码可登录 ----
  const relogin = await login('bob', 'Bob@NewPassw0rd');
  check('改密后新密码可登录', relogin.status === 200, `status=${relogin.status}`);

  // ---- A-E-04 限流 ----
  let blocked = false;
  for (let i = 0; i < 15; i++) {
    const r = await login('carol', 'badpass123');
    if (r.status === 429) { blocked = true; break; }
  }
  check('A-E-04 连续失败触发 429', blocked);

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.name);
    process.exit(1);
  }
}

main().catch((e) => { console.error('\n冒烟测试异常：', e.message); process.exit(1); });