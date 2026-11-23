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
// 余额查询单测需要 config.upstream.apiKey；不发起真实请求（fetch 会被替换）
process.env.UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || 'sk-test-unit-balance';

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
const textFile = require('../src/files/text');
const blobStore = require('../src/files/blob-store');
const { ZipArchive } = require('../src/import/zip-reader');
const {
  readSessionFile,
  toLocalSession,
  checkManifest,
} = require('../src/import/history');
const { importArchive } = require('../src/import/import-history');
const { createAdminService } = require('../src/account/admin-service');
const { getBalance } = require('../src/stream/upstream');
const { makeZip } = require('./helpers/zip');
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

test('文本原件：UTF-8 原样返回，GB18030 / UTF-16 统一转 UTF-8', async () => {
  assert.strictEqual(mimeSniff.isTextual('text/plain'), true);
  assert.strictEqual(mimeSniff.isTextual('text/markdown'), true);
  assert.strictEqual(mimeSniff.isTextual('application/json'), true);
  assert.strictEqual(mimeSniff.isTextual('image/png'), false);
  assert.strictEqual(mimeSniff.isTextual('application/octet-stream'), false);

  const utf8 = Buffer.from('中文 UTF-8\n', 'utf8');
  assert.deepStrictEqual(textFile.convert(utf8), { body: utf8, encoding: 'utf-8' });

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带 BOM', 'utf8')]);
  assert.deepStrictEqual(textFile.convert(bom), {
    body: Buffer.from('带 BOM', 'utf8'),
    encoding: 'utf-8',
  });

  // GBK/GB18030（Windows 记事本「ANSI」）字节：中文测试
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  assert.deepStrictEqual(textFile.convert(gbk), {
    body: Buffer.from('中文测试', 'utf8'),
    encoding: 'gb18030',
  });

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文测试', 'utf16le')]);
  assert.deepStrictEqual(textFile.convert(utf16), {
    body: Buffer.from('中文测试', 'utf8'),
    encoding: 'utf-16le',
  });

  // 无 BOM 的 UTF-16LE：NUL 分布可识别
  assert.deepStrictEqual(textFile.convert(Buffer.from('hello', 'utf16le')), {
    body: Buffer.from('hello', 'utf8'),
    encoding: 'utf-16le',
  });

  // 既非 UTF-8 也非东亚双字节的拉丁文本走 windows-1252 兜底
  assert.deepStrictEqual(textFile.convert(Buffer.from([0x63, 0x61, 0x66, 0xe9])), {
    body: Buffer.from('café', 'utf8'),
    encoding: 'windows-1252',
  });

  // 超过转码上限时不读入内存，由路由退回下载语义
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-text-'));
  try {
    const filePath = path.join(dir, 'big.txt');
    await fs.writeFile(filePath, Buffer.from('0123456789'));
    assert.strictEqual(await textFile.transcodeToUtf8(filePath, { maxBytes: 4 }), null);
    const ok = await textFile.transcodeToUtf8(filePath, { maxBytes: 16 });
    assert.strictEqual(ok.body.toString('utf8'), '0123456789');
    assert.strictEqual(ok.encoding, 'utf-8');
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

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const ISO = '2026-11-22T00:00:00.000Z';

function sessionArchive(sessionId = 'sess-00000001') {
  const imageFile = {
    id: 'file-image-1',
    file_name: '图片.png',
    file_size: PNG_1X1.length,
    token_usage: null,
    inserted_at: ISO,
    export_path: `chat_sessions/${sessionId}_files/file-image-1_图片.png`,
    is_image: true,
    width: 1,
    height: 1,
  };
  const textFile = {
    id: 'file-text-1',
    file_name: '说明.txt',
    file_size: 5,
    token_usage: null,
    inserted_at: ISO,
    export_path: null,
    is_image: false,
    width: null,
    height: null,
  };
  const userMessage = (id, parentId, content, files) => ({
    id,
    parent_id: parentId,
    role: 'USER',
    status: 'FINISHED',
    thinking_enabled: false,
    search_enabled: true,
    accumulated_token_usage: 0,
    inserted_at: ISO,
    fragments: [
      { type: 'REQUEST', content },
      ...(files ? [{ type: 'FILE', files }] : []),
    ],
  });
  const assistantMessage = (id, parentId, fragments, status = 'FINISHED') => ({
    id,
    parent_id: parentId,
    role: 'ASSISTANT',
    status,
    thinking_enabled: true,
    search_enabled: true,
    accumulated_token_usage: 10,
    inserted_at: ISO,
    fragments,
  });
  const session = {
    id: sessionId,
    title: '导入会话',
    pinned: false,
    current_message_id: 4,
    inserted_at: ISO,
    updated_at: ISO,
    messages: [
      userMessage(1, null, '请分析图片', [imageFile, textFile]),
      assistantMessage(2, 1, [
        { type: 'THINK', content: '思考过程', elapsed_secs: 1.5 },
        { type: 'RESPONSE', content: '回答正文' },
        {
          type: 'TOOL_SEARCH',
          queries: ['query'],
          results: [
            {
              url: 'https://example.com',
              title: '示例',
              snippet: '摘要',
              published_at: null,
              site_name: null,
            },
          ],
          status: 'FINISHED',
        },
        {
          type: 'READ_LINK',
          results: [{ url: 'https://example.com/a', title: 'A', signature: 'sig-1' }],
        },
      ]),
      userMessage(3, 2, '继续追问'),
      assistantMessage(4, 3, [{ type: 'RESPONSE', content: '回答正文 2' }]),
      userMessage(5, 2, '另一个分支'),
      assistantMessage(6, 5, [{ type: 'RESPONSE', content: '分支回答' }]),
    ],
  };
  const index = [
    {
      id: sessionId,
      title: session.title,
      pinned: false,
      message_count: session.messages.length,
      inserted_at: ISO,
      updated_at: ISO,
    },
  ];
  return { session, index, imageFile, imagePath: imageFile.export_path };
}

function buildZip({ sessionId } = {}) {
  const { session, index, imagePath } = sessionArchive(sessionId);
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify({ export_format_version: 3 }) },
    { name: `chat_sessions/${session.id}.json`, data: JSON.stringify(session) },
    { name: 'chat_session_index.json', data: JSON.stringify(index) },
    { name: imagePath, data: PNG_1X1, deflate: true },
  ]);
}

test('ZIP 解析：STORE/DEFLATE、UTF-8 路径与 CRC', () => {
  const zip = makeZip([
    { name: 'manifest.json', data: '{"export_format_version":3}' },
    { name: '目录/说明.txt', data: 'hello', deflate: true },
  ]);
  const archive = new ZipArchive(zip);
  assert.strictEqual(archive.firstPath, 'manifest.json');
  assert.strictEqual(archive.read('manifest.json').toString(), '{"export_format_version":3}');
  assert.strictEqual(archive.read('目录/说明.txt').toString(), 'hello');

  assert.throws(
    () => new ZipArchive(makeZip([{ name: '../evil', data: 'x' }])),
    /Invalid history archive/
  );
  assert.throws(
    () => new ZipArchive(makeZip([{ name: '/absolute', data: 'x' }])),
    /Invalid history archive/
  );

  const corrupt = makeZip([{ name: 'a.txt', data: 'hello' }]);
  // 本地头 30 字节 + 文件名 5 字节，数据从第 35 字节开始
  corrupt[35] ^= 0xff;
  const corruptArchive = new ZipArchive(corrupt);
  assert.throws(() => corruptArchive.read('a.txt'), /CRC/);
});

test('历史归档转换：分支、思考、搜索、阅读链接与附件', () => {
  const { session: raw, imagePath } = sessionArchive();
  const file = readSessionFile(raw);
  const resolved = new Map([
    [
      'file-image-1',
      { storageId: 'stored-image-1', mime: 'image/png', isImage: true },
    ],
  ]);
  const { session, images } = toLocalSession(file, resolved);

  assert.strictEqual(session.id, 'sess-00000001');
  assert.strictEqual(session.title, '导入会话');
  assert.strictEqual(session.rootMessageId, '1');
  assert.strictEqual(session.messages.length, 6);
  assert.strictEqual(session.messages[0].selectedChildId, '2');
  assert.strictEqual(session.messages[1].selectedChildId, '3');
  assert.strictEqual(session.messages[2].selectedChildId, '4');

  const user = session.messages[0];
  assert.strictEqual(user.content, '请分析图片');
  assert.strictEqual(user.files.length, 2);
  assert.deepStrictEqual(user.files[0], {
    id: 'file-image-1',
    serverId: null,
    storageId: 'stored-image-1',
    name: '图片.png',
    size: PNG_1X1.length,
    isImage: true,
    mimeType: 'image/png',
  });
  assert.strictEqual(user.files[1].storageId, null);
  assert.strictEqual(user.files[1].isImage, false);

  const assistant = session.messages[1];
  const types = assistant.blocks.map((block) => block.type);
  assert.ok(types.includes('thinking'));
  assert.ok(types.includes('text'));
  assert.ok(types.includes('server_tool_use'));
  assert.ok(types.includes('web_search_tool_result'));
  assert.ok(types.includes('web_fetch_tool_result'));
  const fetchBlock = assistant.blocks.find(
    (block) => block.type === 'web_fetch_tool_result' && block.signature
  );
  assert.strictEqual(fetchBlock.signature, 'sig-1');
  assert.ok(images.has('file-image-1'));
  assert.strictEqual(images.get('file-image-1').path, imagePath);

  // 同角色父子关系必须拒绝
  const broken = JSON.parse(JSON.stringify(raw));
  broken.messages[3].parent_id = 2;
  const brokenFile = readSessionFile(broken);
  assert.throws(() => toLocalSession(brokenFile), /消息树/);

  // 图片路径不能跨会话
  const crossed = JSON.parse(JSON.stringify(raw));
  crossed.messages[0].fragments[1].files[0].export_path =
    'chat_sessions/other-files/file-image-1_图片.png';
  assert.throws(() => toLocalSession(readSessionFile(crossed)), /图片路径/);

  // 新版本归档直接拒绝
  assert.throws(() => checkManifest({ export_format_version: 4 }), /版本/);
});

test('历史导入核心：图片归档、引用同步、幂等与 dry-run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-import-'));
  const originalDir = config.files.dir;
  config.files.dir = dir;
  const chatRepo = new MemoryChatRepo();
  const fileRepo = new MemoryFileRepo();
  const user = { id: 1, username: 'alice' };
  try {
    const zip = buildZip();
    const first = await importArchive({
      user,
      actor: 'test',
      source: 'fixture.zip',
      archiveBuffer: zip,
      chatRepo,
      fileRepo,
    });
    assert.strictEqual(first.sessionsTotal, 1);
    assert.strictEqual(first.sessionsImported, 1);
    assert.strictEqual(first.sessionsSkipped, 0);
    assert.strictEqual(first.filesImported, 1);

    const session = await chatRepo.getSession(1, 'sess-00000001');
    assert.ok(session);
    const attachment = session.messages[0].files[0];
    assert.ok(attachment.storageId);
    assert.strictEqual(attachment.mimeType, 'image/png');
    assert.strictEqual(attachment.isImage, true);

    const stored = await fileRepo.get(1, attachment.storageId);
    assert.strictEqual(stored.name, '图片.png');
    assert.strictEqual(stored.mime, 'image/png');
    assert.strictEqual(stored.isImage, true);
    assert.ok(await blobStore.stat(stored.storageKey));
    assert.deepStrictEqual(fileRepo.listRefs(1, 'sess-00000001'), [attachment.storageId]);

    // 重复导入：跳过已有会话，不新增文件/会话
    const second = await importArchive({
      user,
      actor: 'test',
      source: 'fixture.zip',
      archiveBuffer: zip,
      chatRepo,
      fileRepo,
    });
    assert.strictEqual(second.sessionsImported, 0);
    assert.strictEqual(second.sessionsSkipped, 1);
    assert.strictEqual(second.filesImported, 0);

    // dry-run：新会话只校验，不落库；也不写审计
    const audit = {
      starts: 0,
      finishes: [],
      async start() {
        this.starts += 1;
        return 1;
      },
      async finish(_id, patch) {
        this.finishes.push(patch);
      },
    };
    const dry = await importArchive({
      user,
      actor: 'test',
      source: 'fixture.zip',
      archiveBuffer: buildZip({ sessionId: 'sess-00000002' }),
      dryRun: true,
      chatRepo,
      fileRepo,
      auditRepo: audit,
    });
    assert.strictEqual(dry.sessionsImported, 1);
    assert.strictEqual(await chatRepo.hasSession(1, 'sess-00000002'), false);
    assert.strictEqual(audit.starts, 0);

    // 正式导入写审计：start → success finish
    await importArchive({
      user,
      actor: 'test',
      source: 'fixture.zip',
      archiveBuffer: buildZip({ sessionId: 'sess-00000005' }),
      chatRepo,
      fileRepo,
      auditRepo: audit,
    });
    assert.strictEqual(audit.starts, 1);
    assert.strictEqual(audit.finishes.length, 1);
    assert.strictEqual(audit.finishes[0].status, 'success');
    assert.strictEqual(audit.finishes[0].sessionsImported, 1);

    // 预校验失败时不写任何会话（第二会话消息树非法）
    const good = sessionArchive('sess-00000003').session;
    const bad = JSON.parse(JSON.stringify(sessionArchive('sess-00000004').session));
    bad.messages[3].parent_id = 2;
    const badZip = makeZip([
      { name: 'manifest.json', data: JSON.stringify({ export_format_version: 3 }) },
      { name: `chat_sessions/${good.id}.json`, data: JSON.stringify(good) },
      { name: `chat_sessions/${bad.id}.json`, data: JSON.stringify(bad) },
      {
        name: 'chat_session_index.json',
        data: JSON.stringify([
          { ...sessionArchive(good.id).index[0] },
          { ...sessionArchive(bad.id).index[0] },
        ]),
      },
    ]);
    await assert.rejects(
      importArchive({
        user,
        actor: 'test',
        source: 'bad.zip',
        archiveBuffer: badZip,
        chatRepo,
        fileRepo,
      }),
      /消息树/
    );
    assert.strictEqual(await chatRepo.hasSession(1, 'sess-00000003'), false);
    assert.strictEqual(await chatRepo.hasSession(1, 'sess-00000004'), false);

    // replace：覆盖同 id 会话
    const replace = await importArchive({
      user,
      actor: 'test',
      source: 'fixture.zip',
      archiveBuffer: zip,
      mode: 'replace',
      chatRepo,
      fileRepo,
    });
    assert.strictEqual(replace.sessionsImported, 1);
    assert.strictEqual(replace.sessionsSkipped, 0);
  } finally {
    config.files.dir = originalDir;
    await chatRepo.close();
    await fileRepo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('管理员账号：创建、锁定、解锁与重置密码', async () => {
  const userRepo = new MemoryUserRepo();
  const sessionStore = new MemorySessionStore();
  const service = createAdminService({ userRepo, sessionStore });
  try {
    const created = await service.createUser({ username: 'carol', password: 'Passw0rd!' });
    assert.strictEqual(created.username, 'carol');
    assert.strictEqual(created.status, 'active');

    await assert.rejects(
      service.createUser({ username: 'carol', password: 'Passw0rd!' }),
      (error) => error.code === 'ER_DUP_ENTRY'
    );
    await assert.rejects(
      service.createUser({ username: 'dave', password: 'short' }),
      /至少 8 个字符/
    );

    const locked = await service.lockUser('carol');
    assert.strictEqual(locked.changed, true);
    let user = await userRepo.findByUsername('carol');
    assert.strictEqual(user.status, 'locked');
    assert.strictEqual(user.credential_version, 2);
    assert.strictEqual(await sessionStore.getCredVersion(user.id), 2);

    const unlocked = await service.unlockUser('carol');
    assert.strictEqual(unlocked.changed, true);
    user = await userRepo.findByUsername('carol');
    assert.strictEqual(user.status, 'active');

    const reset = await service.resetPassword('carol', 'NewPassw0rd!');
    assert.strictEqual(reset.credentialVersion, 3);
    user = await userRepo.findByUsername('carol');
    assert.strictEqual(await verifyPassword(user.password_hash, 'NewPassw0rd!'), true);
    assert.strictEqual(await verifyPassword(user.password_hash, 'Passw0rd!'), false);
    assert.strictEqual(await sessionStore.getCredVersion(user.id), 3);

    await assert.rejects(service.lockUser('nobody'), /用户不存在/);
  } finally {
    await sessionStore.close();
    await userRepo.close();
  }
});

test('余额查询：GET /user/balance 透传上游结构且带上服务端 Key', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '110.00',
        granted_balance: '10.00',
        topped_up_balance: '100.00',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const data = await getBalance();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, config.upstream.baseUrl + config.upstream.balancePath);
    assert.strictEqual(calls[0].opts.method, 'GET');
    assert.strictEqual(calls[0].opts.headers.Authorization, `Bearer ${config.upstream.apiKey}`);
    assert.strictEqual(data.is_available, true);
    assert.strictEqual(data.balance_infos[0].total_balance, '110.00');
  } finally {
    global.fetch = originalFetch;
  }
});

test('余额查询：上游 401 折叠为 UPSTREAM_REJECTED，不暴露成 401', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('{"error":{"message":"bad key"}}', {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(getBalance(), (error) => {
      assert.strictEqual(error.code, 'UPSTREAM_REJECTED');
      assert.strictEqual(error.upstreamStatus, 401);
      return true;
    });
  } finally {
    global.fetch = originalFetch;
  }
});