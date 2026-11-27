'use strict';
/**
 * Docker 执行策略。
 *
 * 第一阶段只允许 Python；网络、根文件系统、资源上限全部在服务端固定，
 * 不接受模型参数覆盖。真正的容器创建在阶段 3 接入。
 */
const { config } = require('../../../config');
const { AppError } = require('../../../lib/errors');

const PYTHON_POLICY = Object.freeze({
  language: 'python',
  image: config.agent.pythonImage,
  network: 'none',
  readOnlyRootfs: true,
  privileged: false,
  memoryBytes: config.agent.containerMemoryBytes,
  cpus: config.agent.containerCpus,
  pidsLimit: config.agent.containerPidsLimit,
  timeoutMs: config.agent.scriptTimeoutMs,
});

function getExecutionPolicy(language) {
  if (language !== 'python') throw new AppError('INVALID_INPUT');
  return PYTHON_POLICY;
}

module.exports = { PYTHON_POLICY, getExecutionPolicy };
