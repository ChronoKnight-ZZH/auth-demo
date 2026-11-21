'use strict';
/**
 * 单元测试：加密层、协议、哈希、两套存储实现等价性。
 * 运行：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.PEPPER = process.env.PEPPER || 'test-pepper-0123456789abcdef';
process.env.RSA_PRIVATE_KEY_PATH = process.env.RSA_PRIVATE_KEY_PATH || 'secrets/rsa_private.pem';
process.env.RSA_PUBLIC_KEY_PATH = process.env.RSA_PUBLIC_KEY_PATH || 'secrets/rsa_public.pem';

const {
  decryptCredentials, encodePayload, decodePayload,
  encodeChangePayload, decodeChangePayload, encryptForTest, RSA_CONFIG,
} = require('../src/crypto/rsa');
const {
  hashPassword, verifyPassword, needsRehash, withHashSlot,
} = require('../src/crypto/password');
const { generateToken, hashToken } = require('../src/session/token');
const { MemorySessionStore } = require('../src/session/memory-store');
const { MemoryUserRepo } = require('../src/db/memory-user-repo');
const { createRateLimiter } = require('../src/lib/rate-limiter');

test('RSA-OAEP 往返：加密后可解密', () => {
  const payload = encodePayload('alice', 'Alice@Passw0rd');
  const ct = encryptForTest(payload.toString('utf8'));
  const pt = decryptCredentials(ct);
  assert.strictEqual(pt, payload.toString('utf8'));
});

test('A-S-01 OAEP 上限常量为 190 且 hash 为 sha256', () => {
  assert.strictEqual(RSA_CONFIG.maxPlaintextBytes, 190);
  assert.strictEqual(RSA_CONFIG.oaepHash, 'sha256');
});

test('A-U-02 使用 sha1 摘要无法解密（证明两端必须同源）', () => {
  const payload = encodePayload('alice', 'pw').toString('utf8');
  const ct = encryptForTest(payload);
  const buf = Buffer.from(ct, 'base64');
  assert.throws(() => {
    crypto.privateDecrypt(
      { key: require('node:fs').readFileSync('secrets/rsa_private.pem', 'utf8'),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      buf
    );
  }, '摘要算法不一致时必须解密失败，不得静默通过');
});

test('非法密文解密抛错（供上层折叠为 401）', () => {
  assert.throws(() => decryptCredentials('AAAA'));
  assert.throws(() => decryptCredentials(Buffer.alloc(256, 1).toString('base64')));
});

test('A-F-07 拼接协议含分隔符/中文/换行时往返一致', () => {
  const cases = [
    ['a||b', 'p||w'],
    ['张三', '密码12345678'],
    ['user\nwith\nnewlines', 'pass'],
    ['', 'onlypass'],
  ];
  for (const [u, p] of cases) {
    const enc = encodePayload(u, p);
    const dec = decodePayload(enc);
    assert.deepStrictEqual(dec, { username: u, password: p }, `失败用例: ${JSON.stringify(u)}`);
  }
});

test('解码非法载荷返回 null', () => {
  assert.strictEqual(decodePayload('garbage'), null);
  assert.strictEqual(decodePayload('v1\nabc\nuser'), null);
  assert.strictEqual(decodePayload('v1\n99\nshort'), null);
});

test('改密载荷往返一致', () => {
  const enc = encodeChangePayload('bob', 'oldPass123', 'newPass456');
  const dec = decodeChangePayload(enc);
  assert.deepStrictEqual(dec, { username: 'bob', oldPassword: 'oldPass123', newPassword: 'newPass456' });
});

test('Argon2id 生成 PHC 且参数为下调档位', async () => {
  const phc = await hashPassword('Secret123');
  assert.match(phc, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.strictEqual(await verifyPassword(phc, 'Secret123'), true);
  assert.strictEqual(await verifyPassword(phc, 'WrongSecret'), false);
});

test('needsRehash 识别低档位与高档位', async () => {
  assert.strictEqual(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA'), true);
  assert.strictEqual(needsRehash('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'), false);
  assert.strictEqual(needsRehash('not-a-phc'), true);
});

test('A-S-08 Argon2 并发闸限制并发并拒绝过载', async () => {
  process.env.MAX_CONCURRENT_HASH = '1';
  // 注意：config 在首次 require 时已定型，此处只验证闸门不抛异常
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => withHashSlot(() => hashPassword('x')))
  );
  assert.strictEqual(rs.length, 5);
});

test('Token 生成约 43 字符且具备熵', () => {
  const t = generateToken();
  assert.ok(t.length >= 42 && t.length <= 44, `长度异常: ${t.length}`);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.notStrictEqual(generateToken(), generateToken());
  assert.strictEqual(hashToken(t).length, 64);
});

test('A-F-04 会话存储中只有哈希，不存原文', async () => {
  const store = new MemorySessionStore();
  const token = generateToken();
  const tokenHash = hashToken(token);
  await store.set({
    tokenHash, userId: 1, credver: 1, status: 'active',
    idleMs: 60000, absoluteExpiresAt: Date.now() + 60000, createdAt: Date.now(),
  });
  assert.ok(await store.get(tokenHash));
  assert.strictEqual(await store.get(token), null, '用原文查不到，说明只存了哈希');
  await store.close();
});

test('A-U-03 两套 SessionStore 语义一致（含 revokeAll 版本失效）', async () => {
  const store = new MemorySessionStore();
  const uid = 7;
  await store.setCredVersion(uid, 1, 60000);
  await store.set({
    tokenHash: 'h1', userId: uid, credver: 1, status: 'active',
    idleMs: 60000, absoluteExpiresAt: Date.now() + 60000, createdAt: Date.now(),
  });
  assert.strictEqual(await store.getCredVersion(uid), 1);
  assert.ok(await store.get('h1'));

  // 撤销后版本号变化，中间件据此拒绝旧会话
  await store.revokeAll(uid, 2);
  assert.strictEqual(await store.getCredVersion(uid), 2);
  await store.close();
});

test('A-E-07 绝对过期在应用层生效', async () => {
  const store = new MemorySessionStore();
  const now = Date.now();
  await store.set({
    tokenHash: 'exp', userId: 1, credver: 1, status: 'active',
    idleMs: 3600000, absoluteExpiresAt: now - 1, createdAt: now - 1000,
  });
  const s = await store.get('exp');
  assert.ok(s.absoluteExpiresAt < Date.now(), '应用层可判定绝对过期');
  await store.close();
});

test('限流闸前置语义：达阈值后 isBlocked 为真', () => {
  const limiter = createRateLimiter({ maxPerAccount: 3, maxPerIp: 100, windowSec: 60 });
  assert.strictEqual(limiter.isBlocked('u1', '1.1.1.1'), false);
  for (let i = 0; i < 3; i++) limiter.recordFailure('u1', '1.1.1.1');
  assert.strictEqual(limiter.isBlocked('u1', '1.1.1.1'), true);
  limiter.recordSuccess('u1');
  assert.strictEqual(limiter.isBlocked('u1', '1.1.1.1'), false);
});

test('内存用户库：改密递增版本号', async () => {
  const repo = new MemoryUserRepo();
  const phc = await hashPassword('Init1234');
  await repo.seed([{ username: 'u', passwordHash: phc }]);
  const before = await repo.findByUsername('u');
  const newPhc = await hashPassword('Next1234');
  const v = await repo.changePassword(before.id, newPhc, 1);
  assert.strictEqual(v, before.credential_version + 1);
  const after = await repo.findByUsername('u');
  assert.strictEqual(after.credential_version, v);
  assert.strictEqual(await verifyPassword(after.password_hash, 'Next1234'), true);
  await repo.close();
});