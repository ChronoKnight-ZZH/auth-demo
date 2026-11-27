'use strict';
/**
 * 第一阶段工具定义。
 *
 * 只暴露固定工具；run_script 的语言枚举先锁死为 python。
 * 真正的执行函数在阶段 2/3 注入，这里给出模型可见的 schema。
 */

const fileId = {
  type: 'string',
  minLength: 8,
  maxLength: 64,
};

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_task_files',
    description: '列出当前任务已授权的输入文件和已生成的输出文件。',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    timeoutMs: 5_000,
  },
  {
    name: 'get_file_metadata',
    description: '获取当前任务中某个文件的名称、类型、大小和角色。',
    input_schema: {
      type: 'object',
      properties: { file_id: fileId },
      required: ['file_id'],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
  },
  {
    name: 'read_task_file',
    description: '读取当前任务中某个文本类文件的 UTF-8 内容，超出上限时拒绝。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: fileId,
        max_bytes: { type: 'integer', minimum: 1, maximum: 1_048_576 },
      },
      required: ['file_id'],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
  },
  {
    name: 'run_script',
    description: '在隔离的 Docker 容器中运行 Python 脚本；容器默认禁网且只挂载当前任务目录。',
    input_schema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python'] },
        script: { type: 'string', minLength: 1, maxLength: 262_144 },
      },
      required: ['language', 'script'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
  },
  {
    name: 'list_output_files',
    description: '列出当前任务输出目录中的文件。',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    timeoutMs: 5_000,
  },
  {
    name: 'upload_output_file',
    description: '将当前任务输出目录中的文件上传到现有文件服务，并返回文件 ID 与下载信息。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 255 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
  },
  {
    name: 'get_task_status',
    description: '获取当前任务状态、剩余时间与已用调用次数。',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    timeoutMs: 5_000,
  },
]);

module.exports = { TOOL_DEFINITIONS };
