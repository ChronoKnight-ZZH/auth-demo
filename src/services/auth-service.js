'use strict';
/**
 * 认证业务服务：登录 / 登出 / 改密。
 * 对应方案 §5.1、§6.1、§6.2.3。
 */
const { AppError } = require('../lib/errors');
const { decryptCredentials, decodePayload, decodeChangePayload } = require('../crypto/rsa');
const {
  verifyPassword, hashPassword, needsRehash, withHashSlot, getDummyHash,
} = require('../crypto/password');
const { generateToken, hashToken } = require('../session/token');
const { config } = require('../config');

function createAuthService({ userRepo, sessionStore, limiter }) {
  /**
   * 登录。步骤编号与方案 §5.1 表格对应。
   */
  async function login({ encrypted, ip }) {
    // ---- 步骤 2：解密（失败折叠为统一 401，不含 DECRYPT_FAILED）----
    let plaintext;
    try {
      plaintext = decryptCredentials(encrypted);
    } catch {
      // 折叠：仍付出一次 dummy verify 代价，再返回与密码错误完全一致的响应
      await safeDummyVerify();
      throw new AppError('INVALID_CREDENTIALS');
    }

    // ---- 步骤 3：解析与格式校验 ----
    const parsed = decodePayload(plaintext);
    if (!parsed || !parsed.username || parsed.password.length === 0) {
      throw new AppError('INVALID_INPUT');
    }
    const { username, password } = parsed;
    if ([...username].length > config.maxUsernameChars) throw new AppError('INVALID_INPUT');
    if (Buffer.byteLength(plaintext, 'utf8') > config.rsa.maxPlaintextBytes) {
      throw new AppError('INVALID_INPUT');
    }

    // ---- 步骤 3a：计数前置检查（必须在 argon2 之前）----
    if (limiter.isBlocked(username, ip)) throw new AppError('TOO_MANY_ATTEMPTS');

    // ---- 步骤 4：查询用户 ----
    const user = await userRepo.findByUsername(username);

    // ---- 步骤 5：验证（未知用户也付等价代价，抗时序枚举）----
    const ok = await withHashSlot(async () => {
      if (!user) {
        const dummy = await getDummyHash();
        await verifyPassword(dummy, password).catch(() => false);
        return false;
      }
      return verifyPassword(user.password_hash, password).catch(() => false);
    });

    if (!ok) {
      limiter.recordFailure(username, ip);
      throw new AppError('INVALID_CREDENTIALS');
    }

    // ---- 步骤 4a：账号状态（口令正确后才判定，避免泄露账号是否存在）----
    if (user.status !== 'active') {
      limiter.recordFailure(username, ip);
      throw new AppError('ACCOUNT_LOCKED');
    }

    limiter.recordSuccess(username);

    // ---- 步骤 6：参数升级（异步回写，失败不阻断登录）----
    if (needsRehash(user.password_hash)) {
      hashPassword(password)
        .then((phc) => userRepo.updatePasswordHash(user.id, phc, user.argon2_key_version))
        .catch((e) => console.error('[rehash]', e.message));
    }

    // ---- 步骤 7：签发 Token + 原子写入会话 ----
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const absoluteExpiresAt = now + config.session.absoluteMs;

    try {
      await sessionStore.set({
        tokenHash,
        userId: user.id,
        credver: user.credential_version,
        status: user.status,
        idleMs: config.session.idleMs,
        absoluteExpiresAt,
        createdAt: now,
      });
      // 版本键：供后续撤销比对；值取库中当前版本
      await sessionStore.setCredVersion(
        user.id, user.credential_version, config.session.absoluteMs
      );
    } catch (e) {
      console.error('[session-write]', e.message);
      throw new AppError('SESSION_WRITE_FAILED');
    }

    return { token, expiresAt: absoluteExpiresAt };
  }

  async function safeDummyVerify() {
    try {
      await withHashSlot(async () => {
        const dummy = await getDummyHash();
        await verifyPassword(dummy, 'not-a-real-password').catch(() => false);
      });
    } catch { /* 闸满时不额外阻塞 */ }
  }

  async function logout(tokenHash) {
    await sessionStore.delete(tokenHash);
  }

  /**
   * 改密：校验旧密码 → 更新哈希 → 递增版本 → 写穿版本键。
   * 版本递增使该用户全部旧会话失效（O(1)，非遍历）。
   */
  async function changePassword({ userId, encrypted }) {
    let plaintext;
    try {
      plaintext = decryptCredentials(encrypted);
    } catch {
      throw new AppError('INVALID_INPUT');
    }
    const parsed = decodeChangePayload(plaintext);
    if (!parsed) throw new AppError('INVALID_INPUT');

    const user = await userRepo.findById(userId);
    if (!user) throw new AppError('TOKEN_INVALID');
    if (parsed.username && parsed.username !== user.username) throw new AppError('INVALID_INPUT');
    if (parsed.newPassword.length < 8) throw new AppError('INVALID_INPUT');

    // 旧密码校验：同样走 Argon2 闸门
    const oldOk = await withHashSlot(() =>
      verifyPassword(user.password_hash, parsed.oldPassword).catch(() => false)
    );
    if (!oldOk) throw new AppError('INVALID_CREDENTIALS');

    const phc = await withHashSlot(() => hashPassword(parsed.newPassword));
    const nextVersion = await userRepo.changePassword(user.id, phc, user.argon2_key_version);

    // 写穿版本键：失败则本次改密对会话不生效（不能出现「库已改、旧会话仍有效」）
    try {
      await sessionStore.revokeAll(user.id, nextVersion);
    } catch (e) {
      console.error('[revoke]', e.message);
      throw new AppError('SESSION_WRITE_FAILED');
    }

    // 【刻意不在此删除当前会话】
    // 改密的正确语义是「版本失效」，让中间件的版本比对自然拒绝旧 Token。
    // 若在此顺手删除，会把「版本校验是否生效」这一关键设计掩盖掉。
    return { credentialVersion: nextVersion };
  }

  return { login, logout, changePassword };
}

module.exports = { createAuthService };