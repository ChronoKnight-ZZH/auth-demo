'use strict';
/**
 * SSE 编解码。
 *
 * 与前端 chat-demo/src/services/api/sse.ts 同源规范（WHATWG Server-Sent Events）：
 *   解析：https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * 两个方向各自独立：
 *   - encodeFrame / encodeComment ：后端 → 前端（带 id，供 Last-Event-ID 续推）
 *   - SseFrameParser              ：上游 → 后端（读取上游 SSE 帧）
 */

const CRLF = '\n';

/**
 * 单行字段值中出现换行时，必须拆成多个 data: 行，否则会被对端当成空行派发事件。
 * JSON.stringify 不会产生裸换行，这里仍做防御处理。
 */
function fieldLines(value) {
  const lines = String(value).split(/\r\n|\r|\n/);
  return lines.map((l) => `data: ${l}`).join(CRLF);
}

/**
 * 编码一个事件帧。
 * @param {{id?: number|string, event?: string, data?: string}} frame
 */
function encodeFrame(frame) {
  const out = [];
  if (frame.id !== undefined && frame.id !== null) out.push(`id: ${frame.id}`);
  if (frame.event && frame.event !== 'message') out.push(`event: ${frame.event}`);
  out.push(fieldLines(frame.data === undefined ? '' : frame.data));
  return out.join(CRLF) + CRLF + CRLF;
}

/** 心跳注释行：代理层按「有字节流动」重置空闲超时，前端按规范忽略 */
function encodeComment(text) {
  return `: ${String(text).replace(/[\r\n]/g, ' ')}${CRLF}${CRLF}`;
}

/**
 * 增量 SSE 帧解析器。
 * push(chunkText) 返回本次可完整派发的事件；未结尾的行留在缓冲里。
 */
class SseFrameParser {
  constructor() {
    this.buffer = '';
    this.data = '';
    this.hasData = false;
    this.eventType = '';
    this.lastEventId = '';
  }

  push(text) {
    this.buffer += text;
    const events = [];
    let lineStart = 0;
    const re = /\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(this.buffer)) !== null) {
      // 结尾的 \r 可能是 \r\n 的前半，等下一段再判定
      if (m[0] === '\r' && re.lastIndex === this.buffer.length) break;
      const ev = this._processLine(this.buffer.slice(lineStart, m.index));
      if (ev) events.push(ev);
      lineStart = re.lastIndex;
    }
    this.buffer = this.buffer.slice(lineStart);
    return events;
  }

  /** 流结束：CR 结尾视为完整换行；其余未以空行收尾的事件按规范丢弃 */
  end() {
    const ev = this.buffer.endsWith('\r') ? this._processLine(this.buffer.slice(0, -1)) : null;
    this.buffer = '';
    this.data = '';
    this.hasData = false;
    this.eventType = '';
    return ev ? [ev] : [];
  }

  _processLine(line) {
    if (line === '') return this._dispatch();
    if (line.startsWith(':')) return null; // 注释/保活
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data = this.hasData ? `${this.data}\n${value}` : value;
        this.hasData = true;
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      default:
        break; // retry 等字段对 fetch 流无意义
    }
    return null;
  }

  _dispatch() {
    const ev = this.hasData
      ? { event: this.eventType || 'message', data: this.data, lastEventId: this.lastEventId }
      : null;
    this.data = '';
    this.hasData = false;
    this.eventType = '';
    return ev;
  }
}

module.exports = { encodeFrame, encodeComment, SseFrameParser };
