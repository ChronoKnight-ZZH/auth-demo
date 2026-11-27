'use strict';
/**
 * 工具注册表。
 *
 * 模型只拿到 name / description / input_schema；handler、超时和权限要求
 * 只保留在服务端。未知工具一律拒绝，不接受模型自定义工具。
 */
const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(definition) {
    if (!definition || typeof definition !== 'object') {
      throw new Error('tool definition must be an object');
    }
    if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
      throw new Error(`invalid tool name: ${definition.name}`);
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`duplicate tool: ${definition.name}`);
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      throw new Error(`tool ${definition.name} requires description`);
    }
    if (!definition.input_schema || definition.input_schema.type !== 'object') {
      throw new Error(`tool ${definition.name} requires object input_schema`);
    }
    if (typeof definition.handler !== 'function') {
      throw new Error(`tool ${definition.name} requires handler`);
    }
    const tool = Object.freeze({
      ...definition,
      timeoutMs: definition.timeoutMs ?? 120_000,
    });
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  has(name) {
    return this.tools.has(name);
  }

  /** 发送给模型的工具定义，绝不包含 handler */
  listForModel() {
    return [...this.tools.values()].map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
  }
}

module.exports = { ToolRegistry };
