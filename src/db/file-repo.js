'use strict';
/**
 * 附件原件元数据持久化接口。
 * 物理字节由 files/blob-store 管理，这里只保存元数据与引用。
 */

class FileRepo {
  /* eslint-disable no-unused-vars */
  async ping() { throw new Error('not implemented'); }
  async create(userId, file) { throw new Error('not implemented'); }
  async get(userId, id) { throw new Error('not implemented'); }
  async softDelete(userId, id) { throw new Error('not implemented'); }
  async syncRefs(userId, sessionId, fileIds) { throw new Error('not implemented'); }
  async removeSessionRefs(userId, sessionId) { throw new Error('not implemented'); }
  async clearRefs(userId) { throw new Error('not implemented'); }
  async close() {}
  /* eslint-enable no-unused-vars */
}

module.exports = { FileRepo };
