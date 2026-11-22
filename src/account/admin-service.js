'use strict';
/**
 * 管理员账号操作（CLI 与测试共用）。
 * 约束：不开放注册；账号只能由管理员预置。
 */
const { hashPassword } = require('../crypto/password');
const { config } = require('../config');

const USERNAME_MAX_CHARS = 64;
/** 登录 RSA 明文上限 190 字节，给协议前缀留余量 */
const LOGIN_PAYLOAD_BUDGET = 180;

function validateUsername(username) {
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error('用户名不能为空');
  }
  if ([...username].length > USERNAME_MAX_CHARS) {
    throw new Error(`用户名不能超过 ${USERNAME_MAX_CHARS} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error('用户名不能包含控制字符');
  }
  return username;
}

function validatePassword(username, password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 个字符');
  }
  if (Buffer.byteLength(username, 'utf8') + Buffer.byteLength(password, 'utf8') > LOGIN_PAYLOAD_BUDGET) {
    throw new Error(`用户名与密码的 UTF-8 总长度不能超过 ${LOGIN_PAYLOAD_BUDGET} 字节`);
  }
  return password;
}

async function findUser(userRepo, username) {
  const user = await userRepo.findByUsername(validateUsername(username));
  if (!user) {
    throw new Error(`用户不存在: ${username}`);
  }
  return user;
}

async function revokeSessions(sessionStore, userId, version) {
  if (version === null) {
    throw new Error('无法读取新的凭证版本');
  }
  try {
    await sessionStore.revokeAll(userId, version);
  } catch (error) {
    throw new Error(
      `凭证版本已更新，但写穿 Redis 失败，旧会话可能仍然有效：${error.message}`
    );
  }
}

function createAdminService({ userRepo, sessionStore }) {
  async function listUsers() {
    return userRepo.listUsers();
  }

  async function createUser({ username, password }) {
    validateUsername(username);
    validatePassword(username, password);
    const phc = await hashPassword(password);
    const user = await userRepo.createUser({ username, passwordHash: phc });
    return {
      id: Number(user.id),
      username: user.username,
      status: user.status,
    };
  }

  async function lockUser(username) {
    const user = await findUser(userRepo, username);
    if (user.status === 'locked') {
      return { username: user.username, status: 'locked', changed: false };
    }
    // 先递增版本，再锁定；版本写穿失败时不会出现「已锁定但旧 Token 仍可用」
    const version = await userRepo.revokeCredentials(user.id);
    const changed = await userRepo.setStatus(user.id, 'locked');
    if (!changed) {
      throw new Error('锁定用户失败');
    }
    await revokeSessions(sessionStore, user.id, version);
    return { username: user.username, status: 'locked', changed: true };
  }

  async function unlockUser(username) {
    const user = await findUser(userRepo, username);
    if (user.status === 'active') {
      return { username: user.username, status: 'active', changed: false };
    }
    const changed = await userRepo.setStatus(user.id, 'active');
    if (!changed) {
      throw new Error('解锁用户失败');
    }
    return { username: user.username, status: 'active', changed: true };
  }

  async function resetPassword(username, password) {
    const user = await findUser(userRepo, username);
    validatePassword(username, password);
    const phc = await hashPassword(password);
    // changePassword 在同一事务中递增 credential_version
    const version = await userRepo.changePassword(user.id, phc, user.argon2_key_version);
    await revokeSessions(sessionStore, user.id, version);
    return {
      username: user.username,
      credentialVersion: version,
      ttlDays: Math.round(config.session.absoluteMs / 86400000),
    };
  }

  return { listUsers, createUser, lockUser, unlockUser, resetPassword };
}

module.exports = {
  createAdminService,
  validateUsername,
  validatePassword,
  LOGIN_PAYLOAD_BUDGET,
};
