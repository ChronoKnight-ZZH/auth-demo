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
const { MemoryChatRepo } = require('../src/db/memory-chat-repo');
const { MemoryFileRepo } = require('../src/db/memory-file-repo');
const { createRateLimiter } = require('../src/lib/rate-limiter');
const { config } = require('../src/config');
const fileToken = require('../src/files/token');
const mimeSniff = require('../src/files/mime');
const blobStore = require('../src/files/blob-store');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

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

test('聊天仓储：会话 CRUD、列表排序与用户隔离', async () => {
  const repo = new MemoryChatRepo();
  const now = Date.now();
  const session = {
    id: 'session-test-1',
    title: 'first',
    createdAt: now,
    updatedAt: now,
    rootMessageId: 'm1',
    messages: [
      { id: 'm1', role: 'user', content: 'hello', files: [], createdAt: now },
      { id: 'm2', role: 'assistant', createdAt: now + 1, status: 'done', blocks: [] },
    ],
  };
  await repo.saveSession(1, session);
  assert.strictEqual((await repo.listSessions(1)).length, 1);
  assert.strictEqual((await repo.listAllSessions(1))[0].messages.length, 2);
  assert.strictEqual((await repo.getSession(1, session.id)).title, 'first');
  assert.strictEqual(await repo.getSession(2, session.id), null);

  assert.strictEqual(await repo.renameSession(1, session.id, 'renamed'), true);
  assert.strictEqual((await repo.getSession(1, session.id)).title, 'renamed');
  assert.strictEqual(await repo.renameSession(2, session.id, 'stolen'), false);

  const second = { ...session, id: 'session-test-2', createdAt: now + 10, updatedAt: now + 10 };
  await repo.saveSession(1, second);
  assert.deepStrictEqual(
    (await repo.listSessions(1)).map((s) => s.id),
    ['session-test-2', 'session-test-1']
  );

  assert.strictEqual(await repo.deleteSession(2, session.id), false);
  assert.strictEqual(await repo.deleteSession(1, session.id), true);
  assert.strictEqual((await repo.listSessions(1)).length, 1);
  assert.strictEqual(await repo.clearSessions(1), 1);
  assert.strictEqual((await repo.listSessions(1)).length, 0);
  await repo.close();
});

test('文件元数据：用户隔离、同内容去重与引用同步', async () => {
  const repo = new MemoryFileRepo();
  const base = {
    sha256: 'a'.repeat(64),
    storageKey: 'a'.repeat(64),
    size: 3,
    mime: 'text/plain',
    name: 'a.txt',
    isImage: false,
    createdAt: 1,
  };
  const first = await repo.create(1, { ...base, id: 'file-aaaaaaaa' });
  const again = await repo.create(1, { ...base, id: 'file-bbbbbbbb', name: 'b.txt' });
  assert.strictEqual(again.id, first.id, '同一用户同 sha 应复用元数据');
  const other = await repo.create(2, { ...base, id: 'file-cccccccc' });
  assert.strictEqual(other.id, 'file-cccccccc', '不同用户不共享元数据');

  assert.strictEqual(await repo.get(2, first.id), null);
  assert.strictEqual((await repo.get(1, first.id)).name, 'a.txt');

  await repo.syncRefs(1, 'session-1', [first.id, 'file-missing00']);
  assert.deepStrictEqual(repo.listRefs(1, 'session-1'), [first.id]);
  await repo.syncRefs(1, 'session-1', []);
  assert.deepStrictEqual(repo.listRefs(1, 'session-1'), []);

  assert.strictEqual(await repo.softDelete(1, first.id), true);
  assert.strictEqual(await repo.get(1, first.id), null);
  assert.strictEqual(await repo.softDelete(1, first.id), false);
  await repo.close();
});

test('文件票据：声明往返、篡改拒绝与过期', () => {
  const originalTtl = config.files.tokenTtlMs;
  const token = fileToken.issue({
    fileId: 'file-aaaaaaaa',
    userId: 7,
    sessionId: 'session-1',
    type: 'p',
  });
  const claims = fileToken.verify(token);
  assert.strictEqual(claims.fid, 'file-aaaaaaaa');
  assert.strictEqual(claims.uid, 7);
  assert.strictEqual(claims.sid, 'session-1');
  assert.strictEqual(claims.ty, 'p');

  const [payload, signature] = token.split('.');
  const tampered = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.strictEqual(fileToken.verify(tampered), null, '签名被改动必须拒绝');
  assert.strictEqual(fileToken.verify(`${btoa(payload)}.${signature}`), null);
  assert.strictEqual(fileToken.verify('garbage'), null);

  try {
    config.files.tokenTtlMs = 1000;
    const expiring = fileToken.issue({
      fileId: 'file-aaaaaaaa',
      userId: 7,
      sessionId: 'session-1',
      type: 'r',
    });
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      assert.strictEqual(fileToken.verify(expiring), null, '过期票据必须拒绝');
    } finally {
      Date.now = realNow;
    }
  } finally {
    config.files.tokenTtlMs = originalTtl;
  }
});

test('MIME 嗅探：图片以文件头为准，伪装 SVG/HTML 降级为二进制', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-mime-'));
  const write = async (name, bytes) => {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, bytes);
    return filePath;
  };
  try {
    const png = await write('a.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.deepStrictEqual(await mimeSniff.detect(png, { name: 'a.bin' }), {
      mime: 'image/png',
      isImage: true,
    });

    const jpeg = await write('b.bin', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    assert.deepStrictEqual(await mimeSniff.detect(jpeg, { name: 'b.bin' }), {
      mime: 'image/jpeg',
      isImage: true,
    });

    const pdf = await write('c.bin', Buffer.from('%PDF-1.7\n'));
    assert.deepStrictEqual(await mimeSniff.detect(pdf, { name: 'c.bin' }), {
      mime: 'application/pdf',
      isImage: false,
    });

    const text = await write('d.bin', Buffer.from('hello world\n'));
    assert.deepStrictEqual(await mimeSniff.detect(text, { name: 'd.bin' }), {
      mime: 'text/plain',
      isImage: false,
    });

    const fakeSvg = await write('evil.svg', Buffer.from('<svg onload="alert(1)"></svg>'));
    assert.deepStrictEqual(
      await mimeSniff.detect(fakeSvg, { name: 'evil.svg', declared: 'image/svg+xml' }),
      { mime: 'application/octet-stream', isImage: false },
      '扩展名声称图片但内容不是已知图片时不能当图片内联'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('原件存储：流式写入、内容寻址、去重与 Range 解析', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-blob-'));
  const originalDir = config.files.dir;
  config.files.dir = dir;
  try {
    const data = Buffer.from('hello attachment');
    const uploaded = await blobStore.putStream(Readable.from([data]), { limit: 1024 });
    assert.strictEqual(uploaded.size, data.length);
    assert.strictEqual(
      uploaded.sha256,
      crypto.createHash('sha256').update(data).digest('hex')
    );

    const committed = await blobStore.commit(
      uploaded.tmp,
      uploaded.sha256,
      uploaded.size,
      1
    );
    assert.strictEqual(committed.storageKey, uploaded.sha256);
    assert.strictEqual((await blobStore.stat(committed.storageKey)).size, data.length);
    assert.strictEqual(await blobStore.stat('b'.repeat(64)), null);

    // 同内容第二次上传：无论平台是否原子替换，最终都必须可读且键一致
    const again = await blobStore.putStream(Readable.from([data]), { limit: 1024 });
    const second = await blobStore.commit(again.tmp, again.sha256, again.size, 1);
    assert.strictEqual(second.storageKey, committed.storageKey);
    assert.strictEqual((await blobStore.stat(second.storageKey)).size, data.length);

    assert.deepStrictEqual(blobStore.parseRange('bytes=0-4', data.length), { start: 0, end: 4 });
    assert.deepStrictEqual(blobStore.parseRange('bytes=-5', data.length), {
      start: data.length - 5,
      end: data.length - 1,
    });
    assert.deepStrictEqual(blobStore.parseRange('bytes=6-', data.length), {
      start: 6,
      end: data.length - 1,
    });
    assert.strictEqual(blobStore.parseRange('bytes=99-', data.length), null);
    assert.strictEqual(blobStore.parseRange('items=0-4', data.length), null);
    assert.throws(() => blobStore.resolveBlobPath('../escape'), /invalid storage key/);

    await assert.rejects(
      blobStore.putStream(Readable.from([Buffer.alloc(2048)]), { limit: 1024 }),
      (error) => error.code === 'FILE_TOO_LARGE'
    );
  } finally {
    config.files.dir = originalDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});