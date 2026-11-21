'use strict';
/**
 * 用户持久化层：MySQL 8.4（mysql2/promise）与内存实现。
 * 对应方案 §4.1、§6.1.1。
 */

class UserRepo {
  /* eslint-disable no-unused-vars */
  async findByUsername(username) { throw new Error('not implemented'); }
  async findById(id) { throw new Error('not implemented'); }
  async updatePasswordHash(userId, phc, keyVersion) { throw new Error('not implemented'); }
  async ping() { throw new Error('not implemented'); }
  async seed(users) { throw new Error('not implemented'); }
  async close() {}
  /* eslint-enable no-unused-vars */
}

module.exports = { UserRepo };