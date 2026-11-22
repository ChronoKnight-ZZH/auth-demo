'use strict';
/**
 * 部署监控用的轻量系统信息：磁盘余量与进程内存。
 * 失败时返回 null，健康检查本身不能因为采集指标而 500。
 */
const fsp = require('node:fs/promises');

async function diskInfo(dir) {
  try {
    const stat = await fsp.statfs(dir);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    return {
      totalBytes,
      freeBytes,
      usedPct: totalBytes > 0
        ? Math.round((1 - freeBytes / totalBytes) * 1000) / 10
        : null,
    };
  } catch {
    return null;
  }
}

function processInfo() {
  const memory = process.memoryUsage();
  return {
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

module.exports = { diskInfo, processInfo };
