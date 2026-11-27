'use strict';
/**
 * 任务工作目录管理。
 *
 * 目录布局：
 *   <workspaceDir>/<taskId>/
 *     input/       只读输入（Worker 复制授权文件）
 *     workspace/   脚本与临时文件
 *     output/      最终产物
 *     logs/        执行日志
 *
 * 所有文件名先取 basename 并剥离路径分隔符/控制字符，再拼接到固定目录；
 * 拼接后再用 path.relative 做一次“仍在目录内”校验，防止路径穿越。
 */
const path = require('node:path');
const fsp = require('node:fs/promises');
const { AppError } = require('../../../lib/errors');

const TASK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function safeFileName(raw, fallback = 'file') {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() : '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '_')
    .trim();
  const name = cleaned || fallback;
  if (name === '.' || name === '..') return fallback;
  return [...name].slice(0, 255).join('');
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('INVALID_INPUT');
  }
  return target;
}

class WorkspaceManager {
  constructor({ rootDir, taskId }) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
      throw new AppError('INVALID_INPUT');
    }
    this.rootDir = path.resolve(rootDir);
    this.taskId = taskId;
    this.root = path.join(this.rootDir, taskId);
  }

  get paths() {
    return {
      root: this.root,
      input: path.join(this.root, 'input'),
      workspace: path.join(this.root, 'workspace'),
      output: path.join(this.root, 'output'),
      logs: path.join(this.root, 'logs'),
    };
  }

  async init() {
    const paths = this.paths;
    await Promise.all([
      fsp.mkdir(paths.input, { recursive: true }),
      fsp.mkdir(paths.workspace, { recursive: true }),
      fsp.mkdir(paths.output, { recursive: true }),
      fsp.mkdir(paths.logs, { recursive: true }),
    ]);
    return paths;
  }

  resolveInput(name) {
    return assertInside(this.paths.input, path.join(this.paths.input, safeFileName(name)));
  }

  resolveWorkspace(name) {
    return assertInside(this.paths.workspace, path.join(this.paths.workspace, safeFileName(name)));
  }

  resolveOutput(name) {
    return assertInside(this.paths.output, path.join(this.paths.output, safeFileName(name)));
  }

  resolveLog(name) {
    return assertInside(this.paths.logs, path.join(this.paths.logs, safeFileName(name)));
  }

  async cleanup() {
    await fsp.rm(this.root, { recursive: true, force: true });
  }
}

module.exports = {
  TASK_ID_RE,
  safeFileName,
  assertInside,
  WorkspaceManager,
};
