'use strict';
/**
 * 验收：Argon2 闸门真实生效 + 错误响应不可区分 + 时序抗枚举。
 * 用法：node scripts/verify-gate.js [baseUrl]
 */
const crypto = require('node:crypto');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

async function getMeta() {
  const r = await fetch(BASE + '/auth/public-key');
  return r.json();
}

function encodeLogin(username, password) {
  const ub = Buffer.from(username, 'utf8');
  return Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'), ub, Buffer.from(password, 'utf8'),
  ]).toString('utf8');
}

function encrypt(meta, plaintext) {
  return crypto.publicEncrypt(
    { key: meta.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: meta.oaepHash },
    Buffer.from(plaintext, 'utf8')
  ).toString('base64');
}

async function loginRaw(meta, username, password) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted: encrypt(meta, encodeLogin(username, password)) }),
  });
  const t1 = process.hrtime.bigint();
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body, ms: Number(t1 - t0) / 1e6 };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const meta = await getMeta();
  console.log(`目标：${BASE}\n`);

  // ---- 1. 错误响应逐字节一致（A-S-09 / A-E-02）----
  console.log('1) 错误响应不可区分性');
  const wrongPw = await loginRaw(meta, 'alice', 'DefinitelyWrong1');
  const noUser = await loginRaw(meta, 'no_such_user_xyz', 'DefinitelyWrong1');
  const sameStatus = wrongPw.status === noUser.status;
  const sameBody = JSON.stringify(wrongPw.body) === JSON.stringify(noUser.body);
  console.log(`   密码错误     : ${wrongPw.status} ${JSON.stringify(wrongPw.body)}`);
  console.log(`   账号不存在   : ${noUser.status} ${JSON.stringify(noUser.body)}`);
  console.log(`   ${sameStatus && sameBody ? 'PASS' : 'FAIL'}  状态码与响应体完全一致`);

  // ---- 2. 非法密文也折叠为同一响应（A-E-01）----
  console.log('\n2) 非法密文折叠');
  const badCt = crypto.randomBytes(256).toString('base64');
  const badRes = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted: badCt }),
  });
  const badBody = await badRes.json();
  const folded = badRes.status === wrongPw.status && JSON.stringify(badBody) === JSON.stringify(wrongPw.body);
  console.log(`   非法密文     : ${badRes.status} ${JSON.stringify(badBody)}`);
  console.log(`   ${folded ? 'PASS' : 'FAIL'}  与密码错误响应一致，且不含 DECRYPT_FAILED`);

  // ---- 3. 时序：未知账号不应明显更快（抗枚举）----
  console.log('\n3) 抗时序枚举（未知账号需付出等价 Argon2 代价）');
  const knownTimes = [];
  const unknownTimes = [];
  for (let i = 0; i < 7; i++) {
    knownTimes.push((await loginRaw(meta, 'alice', 'WrongPw' + i)).ms);
    unknownTimes.push((await loginRaw(meta, 'ghost_' + i, 'WrongPw' + i)).ms);
  }
  const mk = median(knownTimes), mu = median(unknownTimes);
  const ratio = mu / mk;
  console.log(`   已知账号中位数: ${mk.toFixed(1)} ms`);
  console.log(`   未知账号中位数: ${mu.toFixed(1)} ms`);
  console.log(`   比值: ${ratio.toFixed(2)}`);
  const timingOk = ratio > 0.5 && ratio < 2.0;
  console.log(`   ${timingOk ? 'PASS' : 'FAIL'}  两者处于同一量级（比值 0.5–2.0）`);

  // ---- 4. 并发闸：突发不应导致 500，只应 429 或 401 ----
  console.log('\n4) Argon2 并发闸（突发不产生 500）');
  const burst = await Promise.all(
    Array.from({ length: 40 }, (_, i) => loginRaw(meta, 'burst_' + i, 'WrongPw' + i))
  );
  const dist = {};
  for (const r of burst) dist[r.status] = (dist[r.status] || 0) + 1;
  console.log('   状态码分布:', JSON.stringify(dist));
  const no500 = !dist[500];
  console.log(`   ${no500 ? 'PASS' : 'FAIL'}  无 500（429 表示闸门生效，401 表示已处理）`);

  // ---- 5. 失败计数前置：连续失败后进入 429 ----
  console.log('\n5) 计数闸前置（达阈值后不再进入 Argon2）');
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await loginRaw(meta, 'alice', 'WrongPw' + i);
    if (r.status === 429) { got429 = true; console.log(`   第 ${i + 1} 次触发 429`); break; }
  }
  console.log(`   ${got429 ? 'PASS' : 'FAIL'}  连续失败触发 429`);

  const allOk = sameStatus && sameBody && folded && timingOk && no500 && got429;
  console.log(`\n${allOk ? '全部通过' : '存在失败项'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('验证异常：', e.message); process.exit(1); });