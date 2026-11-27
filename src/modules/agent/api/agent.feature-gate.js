'use strict';
/**
 * Agent 功能闸。
 *
 * AGENT_ENABLED 是总开关；AGENT_ALLOWLIST 非空时只允许名单内的用户 ID。
 * 默认关闭，生产环境通过环境变量灰度开启。
 */
const { AppError } = require('../../../lib/errors');
const { config } = require('../../../config');

function createAgentFeatureGate({ enabled = config.agent.enabled, allowlist = config.agent.allowlist } = {}) {
  const allowed = new Set((allowlist || []).map((id) => String(id)));

  function assertEnabled() {
    if (!enabled) throw new AppError('AGENT_DISABLED');
  }

  function assertAllowed(userId) {
    assertEnabled();
    if (allowed.size > 0 && !allowed.has(String(userId))) {
      throw new AppError('AGENT_NOT_ALLOWED');
    }
  }

  return { assertEnabled, assertAllowed, enabled, allowlist: [...allowed] };
}

module.exports = { createAgentFeatureGate };
