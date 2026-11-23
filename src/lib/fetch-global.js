'use strict';
/**
 * Node 16 兼容：补齐全局 fetch。
 *
 * Node 18+ 原生提供全局 fetch，Node 16 没有；这里只在缺失时加载 undici@5
 * （支持 Node >=14），Node 18/20 上完全不进入该分支，行为与原生一致。
 * 必须在任何会调用 fetch 的模块之前 require（服务入口、冒烟脚本、测试）。
 */
if (typeof globalThis.fetch !== 'function') {
  const undici = require('undici');
  globalThis.fetch = undici.fetch;
  if (!globalThis.Headers && undici.Headers) globalThis.Headers = undici.Headers;
  if (!globalThis.Request && undici.Request) globalThis.Request = undici.Request;
  if (!globalThis.Response && undici.Response) globalThis.Response = undici.Response;
  if (!globalThis.FormData && undici.FormData) globalThis.FormData = undici.FormData;
}
