'use strict';
/**
 * EventBuffer 接口 —— 断点续推的服务端记忆。
 *
 * 语义约定（三类语义必须严格区分，客户端据此决定「续推」还是「重登」）：
 *   - 状态不存在 / 不属于当前用户 / 已超过 TTL  → 410 STREAM_EXPIRED（该流不可续推）
 *   - 游标早于缓冲起点（缓冲被上限截断）        → 410 CURSOR_EXPIRED（可回退为整条重发）
 *   - 存储本身不可用                            → 503 SESSION_STORE_UNAVAILABLE（非凭证问题，可重试）
 *
 * 编号规则：每条事件获得单调递增 id（首条为 1）。前端 Last-Event-ID 传回最后已收 id，
 * 服务端从 id+1 起续推；id 与 List 下标的换算依赖 firstId，因此截断只从头发生。
 *
 * 本地唤醒：生产者与消费者在同一进程时，append 会即时唤醒 tail，无需等轮询；
 * 跨进程（多实例）退化为 tailPollMs 轮询，Redis 为唯一真相源。
 */
const { EventEmitter } = require('node:events');

const wake = new EventEmitter();
wake.setMaxListeners(0);

/** 由实现类在本地 append 成功后调用 */
function notifyAppended(streamId, firstId) {
  wake.emit(`appended:${streamId}`, firstId);
}

/** 等待该流有新事件（或缓冲起点变化）；超时返回 false，由调用方继续轮询 */
function waitAppend(streamId, timeoutMs) {
  return new Promise((resolve) => {
    const event = `appended:${streamId}`;
    const timer = setTimeout(() => {
      wake.removeListener(event, onAppend);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onAppend = () => {
      clearTimeout(timer);
      wake.removeListener(event, onAppend);
      resolve(true);
    };
    wake.once(event, onAppend);
  });
}

class EventBuffer {
  /* eslint-disable no-unused-vars */
  /** 创建流（原子写入 meta 并设 TTL） */
  async create(streamId, meta) { throw new Error('not implemented'); }
  /** 读取流状态；不存在返回 null */
  async getState(streamId) { throw new Error('not implemented'); }
  /** 追加一帧，返回 { id, firstId } */
  async append(streamId, frame) { throw new Error('not implemented'); }
  /** 读取 afterId 之后的事件，至多 limit 条 */
  async read(streamId, afterId, limit) { throw new Error('not implemented'); }
  /** 结束流：status = done | error */
  async finish(streamId, status, extra) { throw new Error('not implemented'); }
  async close() {}
  /* eslint-enable no-unused-vars */
}

module.exports = { EventBuffer, notifyAppended, waitAppend };
