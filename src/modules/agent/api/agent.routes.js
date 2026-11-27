'use strict';
/**
 * Agent 路由：/api/agent/tasks
 *
 * 所有路由先经过现有 authenticate（HttpOnly Cookie / Bearer 回退），
 * 再由功能闸判断 AGENT_ENABLED 与白名单。状态变更请求继续由全局 CSRF 中间件保护。
 */
const express = require('express');

function createAgentRoutes({ controller, authenticate, featureGate }) {
  const router = express.Router();

  // 任务状态属于用户私有数据，禁止浏览器/代理缓存轮询结果
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticate);
  router.use((req, res, next) => {
    try {
      featureGate.assertEnabled();
      return next();
    } catch (error) {
      return next(error);
    }
  });

  // 任务描述是纯文本，附件走 file_ids 引用；请求体由 app.js 的全局 JSON 解析器处理
  router.post('/tasks', controller.create);
  router.get('/tasks/:taskId', controller.get);
  router.post('/tasks/:taskId/cancel', controller.cancel);
  router.get('/tasks/:taskId/steps', controller.steps);
  router.get('/tasks/:taskId/files', controller.files);
  router.get('/tasks/:taskId/files/:fileId', controller.file);

  return router;
}

module.exports = { createAgentRoutes };
