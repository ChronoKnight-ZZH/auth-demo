'use strict';
/**
 * steps → SSE / JSON 播放器（本地复读机的「协议层」）。
 *
 * 输入是 echo-fixtures 里声明式的步骤（steps），输出可以是四种形态之一：
 *   1. Anthropic 流式（/anthropic/v1/messages，stream:true）
 *   2. OpenAI 流式（/v1/chat/completions，stream:true）
 *   3. Anthropic 非流式 JSON
 *   4. OpenAI 非流式 JSON
 *
 * 目的是让「同一套演示脚本」在两种 API 形状下都能跑，字段严格对齐
 * deepseek-chat-demo/src/services/api/types.ts 与 parseEvent.ts 的校验规则：
 *   - usage 必须四个数值字段齐全，否则前端按无法消费而丢弃；
 *   - message_delta.delta.stop_reason 必须落在 end_turn / max_tokens / tool_use / refusal；
 *   - server_tool_use 原子下发（content_block_start 就带完整 input）；
 *   - thinking 块在结束前用 signature_delta 下发签名（值为本次消息 id）。
 *
 * 同时保留复读机原有的故障注入语义：stopAt（半截收场不发终止帧）、
 * fail=abort（发满 N 帧后关连接）、fail=idle（首块后永久静默）、fail=errorframe。
 */
const crypto = require('node:crypto');

const STOP_TO_FINISH = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/** 把 steps 摊平成「内容块」序列（每个块自带 index） */
function planBlocks(steps, ctx) {
  const blocks = [];
  let seq = 0;
  const push = (b) => blocks.push({ index: blocks.length, ...b });

  for (const step of steps) {
    switch (step.op) {
      case 'thinking':
        push({ kind: 'thinking', chunks: step.chunks.flat(1), gap: step.gap ?? 0 });
        break;
      case 'search': {
        const toolId = `srvtoolu_s_${++seq}_${crypto.randomBytes(8).toString('hex')}`;
        push({
          kind: 'server_tool_use',
          id: toolId,
          name: 'deepseek_web_search',
          kind_: step.kind || 'search',
          input: { action: 'search', queries: step.queries || [], query: (step.queries || [])[0] || '' },
          tool: 'search',
          results: step.results || [],
          gap: step.gap ?? 160,
        });
        push({
          kind: 'web_search_tool_result',
          toolUseId: toolId,
          resultKind: step.kind || 'search',
          results: step.results || [],
          gap: step.gap ?? 160,
        });
        break;
      }
      case 'read_link': {
        const toolId = `srvtoolu_rl_${++seq}_${crypto.randomBytes(8).toString('hex')}`;
        const page = step.page || {};
        push({
          kind: 'server_tool_use',
          id: toolId,
          name: 'deepseek_read_url',
          kind_: 'read_link',
          input: { action: 'read_link', url: step.url },
          tool: 'read_link',
          url: step.url,
          gap: step.gap ?? 140,
        });
        push({
          kind: 'web_fetch_tool_result',
          toolUseId: toolId,
          url: step.url,
          page,
          signature: 'readlink.' + crypto.randomBytes(12).toString('base64url'),
          gap: step.gap ?? 140,
        });
        break;
      }
      case 'tool_use':
        push({
          kind: 'tool_use',
          id: 'toolu_' + crypto.randomBytes(8).toString('hex'),
          name: step.name,
          input: step.input || {},
          gap: step.gap ?? 60,
        });
        break;
      case 'text':
        push({
          kind: 'text',
          chunks: step.chunks.flat(1),
          citations: step.citations || [],
          gap: step.gap ?? 0,
        });
        break;
      case 'finish':
        break;
      default:
        throw new Error(`未知 step.op: ${step.op}`);
    }
  }
  ctx.blocks = blocks;
  return blocks;
}

/** 收尾信息（stop_reason / title / usage） */
function planFinish(steps, blocks, ctx) {
  const fin = steps.find((s) => s.op === 'finish') || {};
  const searchCount = blocks.filter((b) => b.kind === 'web_search_tool_result').length;
  const toolSearchCount = blocks.filter((b) => b.kind === 'server_tool_use').length;
  const outTokens = blocks.reduce((n, b) => n + (b.chunks ? b.chunks.join('').length : 120), 0);
  const usage = {
    input_tokens: Math.max(1, Math.ceil((ctx.inputChars || 0) / 4)),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: Math.max(1, Math.ceil(outTokens / 4)) || 1,
  };
  if (searchCount) {
    usage.server_tool_use = { web_search_requests: searchCount, tool_search: toolSearchCount };
  }
  return {
    stopReason: fin.stop_reason || 'end_turn',
    title: fin.title,
    usage,
  };
}

/** usage 兜底：保证四个数值字段存在（前端 parseEvent 要求） */
function startUsage(usage) {
  return {
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    output_tokens: 0,
  };
}

/** 搜索结果条目 → 协议字段 */
function searchResultItems(results) {
  return results.map((r) => ({
    type: 'web_search_result',
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    site_icon: r.site_icon ?? null,
    site_name: r.site_name ?? null,
    encrypted_content: crypto.randomBytes(24).toString('base64'),
    page_age: r.page_age ?? null,
  }));
}

/** 引用按「第几个增量之后」分组；同一位置可以挂多条（Map 会覆盖，所以手动分组） */
function groupCitations(block) {
  const by = new Map();
  for (const c of block.citations || []) {
    const key = c.after ?? block.chunks.length;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(c);
  }
  return by;
}

// ---------------------------------------------------------------- 工作流轨迹

/** 把 steps 变成人可读的工作流（GET /__workflow、测试台时间线用） */
function workflowOf(steps, blocks, finish, meta) {
  const timeline = [];
  let n = 0;
  for (const b of blocks) {
    n += 1;
    if (b.kind === 'thinking') {
      timeline.push({ seq: n, phase: '思考', event: 'content_block_start(thinking) + thinking_delta×' + b.chunks.length + ' + signature_delta', preview: b.chunks.join('').slice(0, 80) });
    } else if (b.kind === 'server_tool_use') {
      timeline.push({ seq: n, phase: b.tool === 'search' ? '联网搜索' : '阅读链接', event: `content_block_start(server_tool_use/${b.name})`, preview: JSON.stringify(b.input).slice(0, 120) });
    } else if (b.kind === 'web_search_tool_result') {
      timeline.push({ seq: n, phase: '搜索结果', event: 'content_block_start(web_search_tool_result)', preview: b.results.map((r) => r.url).join(' , ').slice(0, 160) });
    } else if (b.kind === 'web_fetch_tool_result') {
      timeline.push({ seq: n, phase: '网页正文', event: 'content_block_start(web_fetch_tool_result)', preview: `${b.url} → ${b.page.title || ''}` });
    } else if (b.kind === 'tool_use') {
      timeline.push({ seq: n, phase: '客户端工具', event: 'content_block_start(tool_use)', preview: `${b.name}(${JSON.stringify(b.input).slice(0, 100)})` });
    } else {
      const cites = b.citations.length ? ` + citations_delta×${b.citations.length}` : '';
      timeline.push({ seq: n, phase: '正文', event: `content_block_start(text) + text_delta×${b.chunks.length}${cites}`, preview: b.chunks.join('').slice(0, 80) });
    }
  }
  return {
    ...meta,
    at: Date.now(),
    stop_reason: finish.stopReason,
    title: finish.title || null,
    usage: finish.usage,
    blocks: blocks.map((b) => b.kind),
    timeline,
  };
}

// ---------------------------------------------------------------- Anthropic 流式

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function playAnthropic(res, { blocks, finish, model, msgId, opts, sleep }) {
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, usage: startUsage(finish.usage),
    },
  });
  sseWrite(res, 'ping', { type: 'ping' });

  if (opts.fail === 'errorframe') {
    sseWrite(res, 'error', {
      type: 'error', error: { type: 'overloaded_error', message: 'echo injected error frame' },
    });
    res.end();
    return;
  }

  const abortAt = opts.fail === 'abort' ? opts.stopAt || 0 : 0;
  let sent = 0;
  let stopped = false;

  for (const b of blocks) {
    if (stopped) break;
    if (b.kind === 'thinking') {
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start', index: b.index, content_block: { type: 'thinking', thinking: '' },
      });
      for (const c of b.chunks) {
        if (opts.stopAt && sent >= opts.stopAt) { stopped = true; break; }
        sseWrite(res, 'content_block_delta', {
          type: 'content_block_delta', index: b.index, delta: { type: 'thinking_delta', thinking: c },
        });
        sent += 1;
        if (abortAt && sent >= abortAt) { res.end(); return; }
        if (b.gap) await sleep(b.gap);
      }
      if (!stopped) {
        sseWrite(res, 'content_block_delta', {
          type: 'content_block_delta', index: b.index, delta: { type: 'signature_delta', signature: msgId },
        });
        sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
      }
    } else if (b.kind === 'server_tool_use') {
      if (b.gap) await sleep(b.gap);
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start',
        index: b.index,
        content_block: {
          type: 'server_tool_use', id: b.id, name: b.name, input: b.input,
          caller: { type: 'direct' }, kind: b.kind_,
        },
      });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
    } else if (b.kind === 'web_search_tool_result') {
      if (b.gap) await sleep(b.gap);
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start',
        index: b.index,
        content_block: {
          type: 'web_search_tool_result', tool_use_id: b.toolUseId,
          kind: b.resultKind, content: searchResultItems(b.results),
        },
      });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
    } else if (b.kind === 'web_fetch_tool_result') {
      if (b.gap) await sleep(b.gap);
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start',
        index: b.index,
        content_block: {
          type: 'web_fetch_tool_result',
          tool_use_id: b.toolUseId,
          kind: 'read_link',
          signature: b.signature,
          content: {
            type: 'web_fetch_result',
            url: b.url,
            content: {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: '' },
              title: b.page.title ?? null,
            },
            published_at: b.page.published_at ?? null,
          },
        },
      });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
    } else if (b.kind === 'tool_use') {
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start',
        index: b.index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      sseWrite(res, 'content_block_delta', {
        type: 'content_block_delta', index: b.index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
    } else {
      // text：引用挂在块尾，cited_text 为「截至该引用处的全部正文」
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start', index: b.index, content_block: { type: 'text', text: '' },
      });
      let acc = '';
      const pending = groupCitations(b);
      for (let i = 0; i < b.chunks.length; i++) {
        if (opts.stopAt && sent >= opts.stopAt) { stopped = true; break; }
        const c = b.chunks[i];
        sseWrite(res, 'content_block_delta', {
          type: 'content_block_delta', index: b.index, delta: { type: 'text_delta', text: c },
        });
        acc += c;
        sent += 1;
        for (const cite of pending.get(i + 1) || []) {
          sseWrite(res, 'content_block_delta', {
            type: 'content_block_delta', index: b.index,
            delta: {
              type: 'citations_delta',
              citation: {
                type: 'web_search_result_location', url: cite.url, title: cite.title ?? null,
                cited_text: acc.trim(), encrypted_index: '',
              },
            },
          });
        }
        if (abortAt && sent >= abortAt) { res.end(); return; }
        if (opts.fail === 'idle' && sent >= 1) return; // 永久静默，交给中继的 idle 超时判死
        if (b.gap) await sleep(b.gap);
      }
      if (!stopped) sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: b.index });
    }
  }

  if (stopped && opts.stopAt) { res.end(); return; } // 半截收场：不发终止帧

  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: finish.stopReason,
      stop_sequence: null,
      ...(finish.title ? { title: finish.title } : {}),
      ...(finish.stopReason === 'refusal' ? { stop_details: { type: 'refusal', category: null, explanation: null } } : {}),
    },
    usage: finish.usage,
  });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ------------------------------------------------------------------ OpenAI 流式

async function playOpenAi(res, { blocks, finish, model, id, opts, sleep }) {
  const created = Math.floor(Date.now() / 1000);
  let sent = 0;
  const send = (delta, finishReason) => {
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    })}\n\n`);
  };
  if (opts.fail === 'errorframe') {
    res.write(`data: ${JSON.stringify({ error: { type: 'overloaded_error', message: 'echo injected error frame' } })}\n\n`);
    res.end();
    return;
  }
  send({ role: 'assistant' });

  for (const b of blocks) {
    if (b.kind === 'thinking') {
      for (const c of b.chunks) {
        if (opts.stopAt && sent >= opts.stopAt) { res.end('\n'); return; }
        send({ reasoning_content: c });
        sent += 1;
        if (b.gap) await sleep(b.gap);
      }
    } else if (b.kind === 'server_tool_use') {
      if (b.gap) await sleep(b.gap);
      send({
        tool_calls: [{
          index: 0, id: b.id, type: 'function',
          function: { name: b.name === 'deepseek_read_url' ? 'read_url' : 'web_search', arguments: JSON.stringify(b.input) },
        }],
      });
    } else if (b.kind === 'web_search_tool_result') {
      if (b.gap) await sleep(b.gap);
      send({ references: b.results.map((r, i) => ({ id: i + 1, title: r.title, url: r.url, content: r.snippet })) });
    } else if (b.kind === 'web_fetch_tool_result') {
      if (b.gap) await sleep(b.gap);
      send({ references: [{ id: 1, title: b.page.title || b.url, url: b.url, content: b.page.summary || '' }] });
    } else if (b.kind === 'tool_use') {
      send({
        tool_calls: [{
          index: 0, id: b.id, type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }],
      });
    } else {
      let acc = '';
      const pending = new Map(b.citations.map((c) => [c.after ?? b.chunks.length, c]));
      for (let i = 0; i < b.chunks.length; i++) {
        if (opts.stopAt && sent >= opts.stopAt) { res.end('\n'); return; }
        send({ content: b.chunks[i] });
        acc += b.chunks[i];
        sent += 1;
        const cite = pending.get(i + 1);
        if (cite) {
          send({ citations: [{ url: cite.url, title: cite.title ?? null, cited_text: acc.trim() }] });
        }
        if (b.gap) await sleep(b.gap);
      }
    }
  }
  send({}, STOP_TO_FINISH[finish.stopReason] || 'stop');
  res.end('data: [DONE]\n\n');
}

// ------------------------------------------------------------------ 非流式

function anthropicMessage(blocks, finish, model, msgId) {
  const content = blocks.map((b) => {
    if (b.kind === 'thinking') {
      return { type: 'thinking', thinking: b.chunks.join(''), signature: msgId };
    }
    if (b.kind === 'server_tool_use') {
      return {
        type: 'server_tool_use', id: b.id, name: b.name, input: b.input,
        caller: { type: 'direct' }, kind: b.kind_,
      };
    }
    if (b.kind === 'web_search_tool_result') {
      return {
        type: 'web_search_tool_result', tool_use_id: b.toolUseId,
        kind: b.resultKind, content: searchResultItems(b.results),
      };
    }
    if (b.kind === 'web_fetch_tool_result') {
      return {
        type: 'web_fetch_tool_result', tool_use_id: b.toolUseId, kind: 'read_link',
        signature: b.signature,
        content: {
          type: 'web_fetch_result', url: b.url,
          content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title: b.page.title ?? null },
          published_at: b.page.published_at ?? null,
        },
      };
    }
    if (b.kind === 'tool_use') {
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    }
    const text = b.chunks.join('');
    return {
      type: 'text',
      text,
      ...(b.citations.length
        ? {
            citations: b.citations.map((c) => ({
              type: 'web_search_result_location', url: c.url, title: c.title ?? null,
              cited_text: text.trim(), encrypted_index: '',
            })),
          }
        : {}),
    };
  });
  return {
    id: msgId, type: 'message', role: 'assistant', model, content,
    stop_reason: finish.stopReason,
    ...(finish.title ? { title: finish.title } : {}),
    usage: finish.usage,
  };
}

function openAiCompletion(blocks, finish, model, id) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  const references = [];
  for (const b of blocks) {
    if (b.kind === 'thinking') message.reasoning_content = b.chunks.join('');
    else if (b.kind === 'text') message.content += b.chunks.join('');
    else if (b.kind === 'server_tool_use' || b.kind === 'tool_use') {
      toolCalls.push({
        id: b.id, type: 'function',
        function: {
          name: b.kind === 'tool_use' ? b.name : b.name === 'deepseek_read_url' ? 'read_url' : 'web_search',
          arguments: JSON.stringify(b.input),
        },
      });
    } else if (b.kind === 'web_search_tool_result') {
      b.results.forEach((r, i) => references.push({ id: references.length + 1, title: r.title, url: r.url, content: r.snippet, index: i + 1 }));
    } else if (b.kind === 'web_fetch_tool_result') {
      references.push({ id: references.length + 1, title: b.page.title || b.url, url: b.url, content: b.page.summary || '' });
    }
  }
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (references.length) message.references = references;
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: STOP_TO_FINISH[finish.stopReason] || 'stop' }],
    usage: {
      prompt_tokens: finish.usage.input_tokens,
      completion_tokens: finish.usage.output_tokens,
      total_tokens: finish.usage.input_tokens + finish.usage.output_tokens,
    },
  };
}

module.exports = {
  planBlocks,
  planFinish,
  workflowOf,
  playAnthropic,
  playOpenAi,
  anthropicMessage,
  openAiCompletion,
  searchResultItems,
  STOP_TO_FINISH,
};
