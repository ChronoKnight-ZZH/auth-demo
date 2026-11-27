'use strict';
/**
 * 默认工具注册表。
 *
 * 第一阶段只注册定义；未注入 handler 的工具统一返回“执行器未就绪”，
 * 避免模型调用到未实现的文件/脚本能力。
 */
const { AppError } = require('../../../lib/errors');
const { ToolRegistry } = require('../core/tool-registry');
const { TOOL_DEFINITIONS } = require('./tool-definitions');

function createDefaultToolRegistry({ handlers = {} } = {}) {
  const registry = new ToolRegistry();
  for (const definition of TOOL_DEFINITIONS) {
    const handler = handlers[definition.name]
      || (async () => { throw new AppError('AGENT_EXECUTOR_UNAVAILABLE'); });
    registry.register({ ...definition, handler });
  }
  return registry;
}

module.exports = { createDefaultToolRegistry };
