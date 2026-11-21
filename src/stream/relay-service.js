'use strict';
/**
 * 中转服务：前端 ⇄ 上游 的流式中继 + 断点续推 + 响应缓存。
 *
 * ── 为什么必须有「生产者 / 消费者」两层 ─────────────────────────────
 * 若把上游读取直接 pipe 给浏览器，浏览器一断连，上游读取也就断了，
 * Last-Event-ID 续推根本无从谈起（服务端没有已发出的字节可回放）。
 * 因此拆成两条独立生命周期：
 *   生产者 producer —— 唯一与上游对话的一方，把每个事件写入 EventBuffer（带单调递增 id）；
 *   消费者 tail     —— 只读 EventBuffer，把 id > cursor 的帧写给浏览器。
 * 浏览器断开只影响 tail；producer 继续跑到自然结束或 orphanTimeout，
 * 期间带 Last-Event-ID 重连的浏览器直接接上，一个 token 都不重发、也不重复计费。
 *
 * ── 先鉴权后推流 ────────────────────────────────────────────────
 *   1) authenticate() 通过才可能写 200 + text/event-stream。
 *   2) 首帧之前还有一段 preflight：上游连不上/熔断/5xx 时用【普通 HTTP 状态码】收场
 *      （502/503/504/429），前端拦截器才能区分「凭证失效」与「上游抖动」两类重发。
 *      已在推流中的失败只能用 SSE error 帧表达。
 *   3) 上游 Key 只出现在 producer → 上游这一跳，绝不写入缓冲、绝不写给前端。
 *   4) 续推只能接回 requestId 属于当前 userId 的流；越界与不存在返回同形 410，
 *      不给出「这个流存在但不是你的」这种可枚举信息。
 */
const crypto = require('node:crypto');
const { config } = require('../config');
const { AppError, sendError, CODES } = require('../lib/errors');
const { CircuitBreaker, withRetry, sleep } = require('../lib/circuit-breaker');
const upstream = require('./upstream');
const { encodeFrame, encodeComment, SseFrameParser } = require('./sse');
const { waitAppend } = require('./event-buffer');
const { makeCacheKey } = require('./cache');

/** 上游终止帧：收到即整条回复结束 */
const TERMINAL_EVENT = 'message_stop';

/** 上游 error 帧的 data 一般是 {type:'error',error:{message}}，保守提取 */
function extractUpstreamError(data) {
  try {
    const obj = JSON.parse(data);
    const m = obj?.error?.message;
    return typeof m === 'string' && m ? m : data;
  } catch {
    return data;
  }
}

/** 写 SSE；res.write 返回 false 不做背压等待（续推有缓冲，慢客户端只会晚一点收到） */
function writeSse(res, text) {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(text); return true; } catch { return false; }
}

class RelayService {
  constructor({ buffer, cache, breaker } = {}) {
    this.buffer = buffer;
    this.cache = cache;
    this.breaker = breaker || new CircuitBreaker();
    /** requestId -> producer 句柄（同进程内共享；跨实例靠缓冲续推） */
    this.producers = new Map();
    /** requestId -> { n, lastSeen } tail 引用计数（孤儿判定依据） */
    this.tails = new Map();
    this.active = { global: 0, byUser: new Map() };
  }

  // ---------------------------------------------------------------- 并发闸

  _acquireSlot(userId) {
    if (this.active.global >= config.stream.maxConcurrent) throw new AppError('RELAY_BUSY');
    const n = this.active.byUser.get(userId) || 0;
    if (n >= config.stream.maxPerUser) throw new AppError('RELAY_BUSY');
    this.active.global += 1;
    this.active.byUser.set(userId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.global -= 1;
      const cur = (this.active.byUser.get(userId) || 1) - 1;
      if (cur <= 0) this.active.byUser.delete(userId);
      else this.active.byUser.set(userId, cur);
    };
  }

  _touchTail(requestId) {
    let rec = this.tails.get(requestId);
    if (!rec) { rec = { n: 0, lastSeen: Date.now() }; this.tails.set(requestId, rec); }
    rec.lastSeen = Date.now();
    return rec;
  }

  // ---------------------------------------------------------------- 入参校验

  /** 在进入上游之前把「不该转发」挡在网关；返回规整后的 body */
  validateBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_INPUT');
    if (typeof body.model !== 'string' || !body.model || body.model.length > 128) {
      throw new AppError('INVALID_INPUT');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new AppError('INVALID_INPUT');
    if (body.messages.length > config.maxMessages) throw new AppError('INVALID_INPUT');
    if (config.upstream.allowedModels.length && !config.upstream.allowedModels.includes(body.model)) {
      throw new AppError('MODEL_NOT_ALLOWED');
    }
    // 尺寸闸：附件走 file_id 引用，messages 里不应出现 base64 原件
    if (Buffer.byteLength(JSON.stringify(body.messages)) > 2 * 1024 * 1024) {
      throw new AppError('INVALID_INPUT');
    }
    return body;
  }

  /** 只转发白名单字段：防止前端塞入未知参数改变上游行为 */
  sanitizeToUpstream(body) {
    const out = { model: body.model, messages: body.messages, stream: true };
    for (const k of ['system', 'max_tokens', 'temperature', 'top_p', 'top_k',
      'stop_sequences', 'thinking', 'tools', 'tool_choice', 'metadata']) {
      if (body[k] !== undefined) out[k] = body[k];
    }
    return out;
  }

  /** 续推游标：Last-Event-ID 优先（SSE 规范），其次 ?cursor= */
  parseCursor(req) {
    const raw = req.headers['last-event-id'] ?? req.query?.cursor;
    if (raw === undefined || raw === null || raw === '') return { cursor: 0, explicit: false };
    const s = String(raw).trim();
    if (!/^\d{1,15}$/.test(s)) throw new AppError('CURSOR_INVALID');
    return { cursor: Number(s), explicit: true };
  }

  /**
   * 只读续推（GET /v1/chat/stream?requestId=&cursor=）。
   * 不校验 body：这条路径没有请求体，语义就是「把已有流从 cursor 接下去」。
   */
  async resume(req, res) {
    const requestId = this.resolveRequestId(req, {});
    const { cursor, explicit } = this.parseCursor(req);
    if (!explicit) throw new AppError('CURSOR_INVALID');
    const state = await this._getStateChecked(requestId, req.userId);
    if (state.firstId > 1 && cursor < state.firstId - 1) throw new AppError('CURSOR_EXPIRED');
    this._touchTail(requestId);
    return this._attachTail(req, res, { requestId, userId: req.userId, cursor, preflight: false });
  }

  /** 服务端生成可续推的 requestId；前端传入则复用（前端得知道 id 才能带 Last-Event-ID 重连） */
  resolveRequestId(req, body) {
    const fromHeader = req.headers['x-request-id'];
    const fromQuery = req.query?.requestId;
    const raw = (typeof fromHeader === 'string' && fromHeader.trim())
      ? fromHeader.trim()
      : (typeof fromQuery === 'string' && fromQuery.trim())
        ? fromQuery.trim()
        : (typeof body?.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : '');
    if (raw) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(raw)) throw new AppError('INVALID_INPUT');
      return raw;
    }
    return crypto.randomBytes(12).toString('base64url');
  }

  // ---------------------------------------------------------------- 主入口

  /**
   * POST /v1/chat/stream（req.userId 已由 authenticate 注入）。
   * 三种进入路径：续推 / 幂等接回 / 新开上游请求。
   */
  /**
   * 模拟路由层收口之外的统一错误映射：
   * UpstreamError.code 与 CODES 表同名，因此可以直接作为 HTTP 状态返回。
   */
  static toAppError(err) {
    if (err instanceof AppError) return err;
    const code = err && typeof err.code === 'string' ? err.code : 'INTERNAL';
    if (CODES[code]) return new AppError(code);
    return new AppError('UPSTREAM_ERROR');
  }

  async handle(req, res) {
    try {
      return await this._handle(req, res);
    } catch (err) {
      // 未推流：以普通 HTTP 状态码收场（前端 401/429/5xx 拦截器的依据）
      if (res.headersSent) throw err;
      if (err instanceof AppError) return sendError(res, err.code);
      if (err && err.code === 'UPSTREAM_TIMEOUT') return sendError(res, 'UPSTREAM_TIMEOUT');
      if (err && err.code === 'UPSTREAM_REJECTED') return sendError(res, 'UPSTREAM_REJECTED');
      if (err && err.code === 'UPSTREAM_ERROR') return sendError(res, 'UPSTREAM_ERROR');
      if (err && err.code === 'UPSTREAM_NOT_CONFIGURED') return sendError(res, 'UPSTREAM_NOT_CONFIGURED');
      console.error('[relay]', err && err.stack ? err.stack : err);
      return sendError(res, 'INTERNAL');
    }
  }

  async _handle(req, res) {
    const userId = req.userId;
    const { cursor, explicit } = this.parseCursor(req);
    const requestId = this.resolveRequestId(req, req.body);

    // A. 续推：带 Last-Event-ID / cursor 的请求绝不打上游，因此不需要请求体
    if (explicit) {
      const state = await this._getStateChecked(requestId, userId);
      if (state.firstId > 1 && cursor < state.firstId - 1) throw new AppError('CURSOR_EXPIRED');
      this._touchTail(requestId);
      return this._attachTail(req, res, { requestId, userId, cursor, preflight: false });
    }

    const body = this.validateBody(req.body);
    // B. 幂等接回：同 requestId 已在跑或已结束（前端重复提交 / 未带游标的裸重连）
    let existing = null;
    try { existing = await this.buffer.getState(requestId); }
    catch (e) { console.error('[buffer-get]', e.message); throw new AppError('SESSION_STORE_UNAVAILABLE'); }
    if (existing) {
      // 别人的 requestId：拒绝而非接回。requestId 是 96 位随机值，正常客户端不会撞上；
      // 撞上也只给 400，不回吐该流的任何信息。
      if (String(existing.userId) !== String(userId)) throw new AppError('INVALID_INPUT');
      this._touchTail(requestId);
      return this._attachTail(req, res, { requestId, userId, cursor: 0, preflight: false });
    }

    if (!config.upstream.apiKey) throw new AppError('UPSTREAM_NOT_CONFIGURED');
    const upstreamBody = this.sanitizeToUpstream(body);

    // C. 缓存命中：灌进缓冲后走同一条 tail 路径（因此回放途中断线同样可续推）
    if (config.cache.enabled) {
      const key = makeCacheKey(userId, upstreamBody);
      let hit = null;
      try { hit = await this.cache.get(key); } catch (e) { console.error('[cache-get]', e.message); }
      if (hit && Array.isArray(hit.frames) && hit.frames.length) {
        return this._replayFromCache(req, res, { requestId, userId, hit, upstreamBody, key });
      }
    }

    // D. 新开上游请求
    const releaseSlot = this._acquireSlot(userId);
    try {
      await this.buffer.create(requestId, {
        userId,
        requestId,
        bodyHash: crypto.createHash('sha256').update(JSON.stringify(upstreamBody)).digest('hex'),
      });
    } catch (e) {
      releaseSlot();
      console.error('[buffer-create]', e.message);
      throw new AppError('SESSION_STORE_UNAVAILABLE');
    }
    this._touchTail(requestId); // 让孤儿计时从「现在」起算，而不是从 0 起算
    const handle = this._startProducer({ requestId, userId, upstreamBody, releaseSlot });
    this.producers.set(requestId, handle);
    return this._attachTail(req, res, { requestId, userId, cursor: 0, preflight: true });
  }

  async _getStateChecked(requestId, userId) {
    let state;
    try { state = await this.buffer.getState(requestId); }
    catch (e) { console.error('[buffer-get]', e.message); throw new AppError('SESSION_STORE_UNAVAILABLE'); }
    // 不存在 / 已过期 / 属于他人 —— 三者同形，避免 requestId 枚举
    if (!state || String(state.userId) !== String(userId)) throw new AppError('STREAM_EXPIRED');
    return state;
  }

  // ---------------------------------------------------------------- 生产者

  _startProducer({ requestId, userId, upstreamBody, releaseSlot }) {
    const abort = new AbortController();
    const startedAt = Date.now();
    let opened = null;
    if (config.cache.enabled) {
      // 缓存需要知道命中的键；由 tail 结束后统一写
      abort._cacheKey = makeCacheKey(userId, upstreamBody);
    }

    const done = (async () => {
      let stopReason = null;
      const collected = config.cache.enabled ? [] : null;
      try {
        // 重试只覆盖「尚未拿到任何 token」的阶段：
        // openStream 成功后由 _pumpUpstream 抛出的错误不会回到这里重试，
        // 因为已产出增量再重发上游 = 重复内容 + 重复计费，那种情况只能靠续推。
        const open = await withRetry(
          async () => {
            if (!this.breaker.allow()) throw new AppError('UPSTREAM_UNAVAILABLE');
            try {
              const h = await upstream.openStream(upstreamBody, { signal: abort.signal });
              opened = h;
              return h;
            } catch (err) {
              if (err instanceof AppError) throw err;          // 熔断/未配置：不记失败，已在上游外计入
              if (err.code === 'ABORTED') throw err;           // 主动取消：与健康无关
              if (err.retryable) this.breaker.recordFailure(err);
              else this.breaker.recordSuccess();               // 上游 4xx：活着，是本请求的问题
              throw err;
            }
          },
          {
            shouldAbort: () => abort.signal.aborted,
            onRetry: (attempt, delay) => console.warn(`[upstream-retry] ${requestId} #${attempt} after ${delay}ms`),
          }
        );

        this.breaker.recordSuccess();
        const pumped = await this._pumpUpstream(requestId, open, abort.signal, collected, (r) => { stopReason = r; });
        open.stop();
        if (!pumped.sawTerminal && !abort.signal.aborted) {
          // 上游没给 message_stop 就结束：视为中断，交给续推/重试，不写缓存
          throw new upstream.UpstreamError('UPSTREAM_ERROR', 'upstream ended without message_stop', { retryable: true });
        }
        await this.buffer.finish(requestId, 'done', { finishReason: stopReason });
        if (collected && collected.length) await this._storeCache(abort._cacheKey, collected, stopReason);
      } catch (err) {
        const code = err instanceof AppError ? err.code : (err.code || 'UPSTREAM_ERROR');
        console.error(`[producer ${requestId}] ${code}: ${err.message}`);
        // 只记终态，不额外塞 error 帧：
        //   首帧之前失败 → tail 的 preflight 看到 status=error && count=0，用普通 HTTP 状态码返回；
        //   已有帧之后失败 → tail 用 relay_end 帧带 code 收场，前端按游标续推。
        // 若在这里追加帧，count 就变成非 0，「上游不可用」再也无法用 502/503/504 表达。
        await this.buffer.finish(requestId, 'error', { errorCode: code }).catch(() => {});
      } finally {
        opened?.stop?.();
        this.producers.delete(requestId);
        releaseSlot();
      }
    })();

    // 孤儿保护：没有任何 tail 在看时，producer 最多再跑 orphanTimeout（保护续推能力，同时封顶成本）
    const orphan = setInterval(() => {
      const rec = this.tails.get(requestId);
      const watching = rec && rec.n > 0;
      const silentFor = Date.now() - (rec ? rec.lastSeen : startedAt);
      if (!watching && silentFor > config.stream.orphanTimeoutMs) {
        abort.abort(new Error('orphan timeout'));
        clearInterval(orphan);
      }
    }, Math.max(1000, config.stream.tailPollMs * 5));
    orphan.unref();

    return { requestId, userId, done, abort, stop: () => abort.abort(new Error('server shutdown')) };
  }

  /** 上游 SSE → 缓冲。逐帧透传，收到 message_stop 即收流 */
  async _pumpUpstream(requestId, open, signal, collected, onReason) {
    const reader = open.response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    let sawTerminal = false;
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
        let chunkResult;
        try {
          chunkResult = await reader.read();
        } catch (e) {
          // abort 引发的读失败：优先抛超时等「真正的原因」，保留 code 供熔断/状态码归类
          if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
          throw e;
        }
        const { done, value } = chunkResult;
        if (done) break;
        open.noteActivity();
        if (!value) continue;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.event === 'error') {
            console.error(`[upstream-error-frame ${requestId}] ${extractUpstreamError(ev.data)}`);
          }
          const appended = await this.buffer.append(requestId, { event: ev.event, data: ev.data });
          if (!appended) return { sawTerminal }; // 缓冲已过期，继续无意义
          if (collected) collected.push({ event: ev.event, data: ev.data });
          if (ev.event === 'message_delta') {
            try {
              const o = JSON.parse(ev.data);
              if (typeof o?.delta?.stop_reason === 'string') onReason(o.delta.stop_reason);
            } catch { /* 非 JSON 忽略 */ }
          }
          if (ev.event === TERMINAL_EVENT) {
            sawTerminal = true;
            return { sawTerminal }; // 不再等上游把连接关掉
          }
        }
      }
      for (const ev of parser.end()) {
        const appended = await this.buffer.append(requestId, { event: ev.event, data: ev.data });
        if (!appended) break;
        if (collected) collected.push({ event: ev.event, data: ev.data });
        if (ev.event === TERMINAL_EVENT) sawTerminal = true;
      }
      return { sawTerminal };
    } finally {
      try { reader.releaseLock(); } catch { /* 已释放 */ }
    }
  }

  async _storeCache(key, frames, stopReason) {
    if (!key) return;
    try {
      const bytes = frames.reduce((a, f) => a + Buffer.byteLength(f.data) + f.event.length + 16, 0);
      const stored = await this.cache.set(key, {
        frames, bytes, finishReason: stopReason || null, cachedAt: Date.now(),
      });
      if (!stored) console.warn('[cache-set] 超出单条上限，跳过缓存');
    } catch (e) {
      console.error('[cache-set]', e.message); // 缓存写失败不影响已下发的流
    }
  }

  /** 缓存命中：把帧灌进缓冲 → 结束 → 同一条 tail 下发 */
  async _replayFromCache(req, res, { requestId, userId, hit, upstreamBody, key }) {
    const releaseSlot = this._acquireSlot(userId);
    try {
      await this.buffer.create(requestId, {
        userId, requestId,
        bodyHash: crypto.createHash('sha256').update(JSON.stringify(upstreamBody)).digest('hex'),
      });
      for (const f of hit.frames) {
        const appended = await this.buffer.append(requestId, { event: f.event, data: f.data });
        if (!appended) break;
      }
      await this.buffer.finish(requestId, 'done', { finishReason: hit.finishReason || 'cached' });
      void key;
    } catch (e) {
      if (e instanceof AppError) throw e;
      console.error('[cache-replay]', e.message);
      throw new AppError('SESSION_STORE_UNAVAILABLE');
    } finally {
      releaseSlot(); // 回放下游只读缓冲，不占上游额度
    }
    this._touchTail(requestId);
    return this._attachTail(req, res, { requestId, userId, cursor: 0, preflight: false, fromCache: true });
  }

  // ---------------------------------------------------------------- 消费者

  /**
   * 把缓冲里 id > cursor 的帧写给浏览器。
   * 只做「读缓冲 + 写响应」，因此可以被断开、重连、与多个 tail 并发共享。
   */
  async _attachTail(req, res, { requestId, userId, cursor, preflight, fromCache }) {
    // ── preflight：首帧之前不写 SSE 头，让「上游不可用」以真实 HTTP 状态码返回 ──
    if (preflight) {
      const gate = await this._waitForFirstFrame(requestId);
      if (gate === 'aborted' || gate === 'gone') {
        if (gate === 'gone') return sendError(res, 'STREAM_EXPIRED');
        try { res.destroy(); } catch { /* ignore */ }
        return;
      }
      if (gate.status === 'error' && gate.count === 0) {
        // 未产出任何帧：客户端取消按静默收场，其余按状态码表返回
        if (gate.errorCode === 'ABORTED') { try { res.destroy(); } catch { /* ignore */ } return; }
        return sendError(res, gate.errorCode || 'UPSTREAM_ERROR');
      }
    }
    if (res.headersSent || res.writableEnded) return;

    const rec = this._touchTail(requestId);
    rec.n += 1;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',   // 关掉 Nginx 响应缓冲，否则 SSE 会被攒成一坨
      'X-Request-Id': requestId,   // 前端据此带 Last-Event-ID 续推
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders?.();

    const abort = new AbortController();
    const onClose = () => abort.abort(new Error('client closed'));
    req.on('close', onClose);
    res.on('error', onClose);

    const heartbeat = setInterval(() => {
      rec.lastSeen = Date.now();
      writeSse(res, encodeComment('hb'));
      // 长流保活：SSE 只在建立时鉴权一次，若流跑过 SESSION_IDLE_MS，
      // 会话会因空闲而消失，续推就变成「凭证失效」。心跳顺带滑动续期。
      if (typeof req.touchSession === 'function') req.touchSession();
    }, config.stream.heartbeatMs);
    heartbeat.unref();

    let next = cursor;
    let lastCount = -1;
    let lastGrowthAt = Date.now();
    let lastSessionTouch = Date.now();
    try {
      // relay_meta 不带 id：它是传输层信息，不能污染浏览器 EventSource 的 lastEventId，
      // 否则断线重连时游标会指向这帧而不是真实内容帧。
      writeSse(res, encodeFrame({
        event: 'relay_meta',
        data: JSON.stringify({ requestId, cursor, resumed: cursor > 0, cached: Boolean(fromCache) }),
      }));

      for (;;) {
        const chunk = await this.buffer.read(requestId, next, 500);
        if (!chunk) { this._closeFailed(res, 'STREAM_EXPIRED', next, requestId); break; }
        if (chunk.truncated) { this._closeFailed(res, 'CURSOR_EXPIRED', next, requestId); break; }

        for (const f of chunk.items) {
          if (abort.signal.aborted) break;
          if (!writeSse(res, encodeFrame({ id: f.id, event: f.event, data: f.data }))) {
            abort.abort(new Error('write failed'));
            break;
          }
          next = f.id;
        }
        if (abort.signal.aborted) break;

        const state = await this.buffer.getState(requestId);
        if (!state) { this._closeFailed(res, 'STREAM_EXPIRED', next, requestId); break; }
        if (chunk.count > lastCount) { lastCount = chunk.count; lastGrowthAt = Date.now(); }

        if (next >= state.count) {
          if (state.status === 'done' || state.status === 'error') {
            // 终止帧 relay_end 不带 id：它是传输层信息，不能污染浏览器 EventSource 的游标，
            // 否则重连时 Last-Event-ID 会指向这帧而不是最后一个真实内容帧。
            this._writeEnd(res, { requestId, state, fromCache });
            break;
          }
          // 仍在生产：本进程没有生产者（跨实例续推）且缓冲久无增长 → 判死
          const mine = this.producers.has(requestId);
          if (!mine && Date.now() - lastGrowthAt > config.stream.tailStallMs) {
            this._writeEnd(res, {
              requestId,
              state: { status: 'error', errorCode: 'UPSTREAM_TIMEOUT' },
              fromCache,
            });
            break;
          }
          await waitAppend(requestId, config.stream.heartbeatMs);
          if (abort.signal.aborted) break;
        }
      }
    } catch (e) {
      console.error(`[tail ${requestId}] ${e.message}`);
      // 头已写出，只能用帧收场
      writeSse(res, encodeFrame({
        event: 'relay_end',
        data: JSON.stringify({ requestId, status: 'error', code: 'INTERNAL' }),
      }));
      try { res.end(); } catch { /* ignore */ }
    } finally {
      clearInterval(heartbeat);
      req.removeListener('close', onClose);
      res.removeListener('error', onClose);
      rec.n = Math.max(0, rec.n - 1);
      rec.lastSeen = Date.now();
      // 无 tail 且无生产者：记录可回收（避免 Map 随 requestId 无限增长）
      if (rec.n === 0 && !this.producers.has(requestId)) this.tails.delete(requestId);
    }
  }

  /** 等新流出现首帧或终态；返回 state / 'gone' / 'aborted' */
  async _waitForFirstFrame(requestId) {
    const deadline = Date.now() + config.upstream.headersTimeoutMs + config.stream.retry.baseBackoffMs * 4;
    for (;;) {
      let state;
      try { state = await this.buffer.getState(requestId); } catch { return 'gone'; }
      if (!state) return 'gone';
      if (state.count > 0 || state.status !== 'inflight') return state;
      if (Date.now() > deadline) return state;
      const woke = await waitAppend(requestId, config.stream.tailPollMs);
      if (!woke && Date.now() > deadline) return state;
    }
  }

  /**
   * 收场：头未写出用普通 HTTP 状态码；已写出用 relay_end 帧（不带 id，见 _attachTail 注释）。
   */
  _closeFailed(res, code, next, requestId) {
    void next;
    if (!res.headersSent) return sendError(res, code);
    writeSse(res, encodeFrame({
      event: 'relay_end',
      data: JSON.stringify({ requestId, status: 'error', code }),
    }));
    try { res.end(); } catch { /* ignore */ }
    return true;
  }

  _writeEnd(res, { requestId, state, fromCache }) {
    writeSse(res, encodeFrame({
      event: 'relay_end',
      data: JSON.stringify({
        requestId,
        status: state.status,
        finishReason: state.finishReason || null,
        code: state.status === 'error' ? (state.errorCode || 'UPSTREAM_ERROR') : null,
        cached: Boolean(fromCache),
      }),
    }));
    try { res.end(); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- 运维

  async stopAll() {
    for (const h of this.producers.values()) h.stop();
    const until = Date.now() + 2000;
    while (this.producers.size && Date.now() < until) await sleep(50);
    this.producers.clear();
  }

  stats() {
    return {
      activeProducers: this.producers.size,
      activeTails: [...this.tails.values()].reduce((a, t) => a + t.n, 0),
      slots: { global: this.active.global, users: this.active.byUser.size },
      breaker: this.breaker.snapshot(),
      cacheEnabled: config.cache.enabled,
    };
  }
}

module.exports = { RelayService, TERMINAL_EVENT, extractUpstreamError };
