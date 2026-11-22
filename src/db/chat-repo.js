'use strict';
/**
 * 聊天会话持久化层。
 * 当前实现把整条会话的 messages 作为 JSON 保存：分支、版本、思考块、
 * 工具块、引用和错误信息都能原样往返，避免在 Demo 阶段过早拆表。
 */

class ChatRepo {
  /* eslint-disable no-unused-vars */
  async ping() { throw new Error('not implemented'); }
  async listSessions(userId) { throw new Error('not implemented'); }
  async listAllSessions(userId) { throw new Error('not implemented'); }
  async getSession(userId, id) { throw new Error('not implemented'); }
  /** 会话是否存在（含已软删除），供导入幂等判断 */
  async hasSession(userId, id) { throw new Error('not implemented'); }
  async saveSession(userId, session) { throw new Error('not implemented'); }
  /** 物理删除会话，仅导入回滚/覆盖使用；调用方需自行清理附件引用 */
  async purgeSession(userId, id) { throw new Error('not implemented'); }
  async renameSession(userId, id, title) { throw new Error('not implemented'); }
  async deleteSession(userId, id) { throw new Error('not implemented'); }
  async clearSessions(userId) { throw new Error('not implemented'); }
  async close() {}
  /* eslint-enable no-unused-vars */
}

module.exports = { ChatRepo };
