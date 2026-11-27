'use strict';
/**
 * 工具执行器：参数二次校验 + 超时 + 未知工具拒绝。
 *
 * 模型返回的 tool_use 不可信，必须在服务端重新校验；handler 拿到的
 * 是 schema 过滤后的参数，不包含任何未知字段。
 */
const { AppError } = require('../../../lib/errors');
const { validateToolInput } = require('./tool-schema');

async function executeTool({ registry, name, input, context = {}, timeoutMs }) {
  const tool = registry.get(name);
  if (!tool) throw new AppError('AGENT_TOOL_NOT_FOUND');

  const parsed = validateToolInput(tool.input_schema, input ?? {});
  if (!parsed.ok) {
    const error = new AppError('AGENT_TOOL_INVALID_INPUT');
    error.details = parsed.errors;
    throw error;
  }

  const limit = timeoutMs ?? tool.timeoutMs ?? 120_000;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => tool.handler(parsed.value, context)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError('AGENT_TOOL_TIMEOUT')), limit);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { executeTool };
