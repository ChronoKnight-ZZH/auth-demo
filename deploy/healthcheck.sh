#!/usr/bin/env bash
# auth-demo 健康检查（systemd timer 或外部监控调用）
# 退出码：0 正常；1 异常。输出直接进 journal / 监控捕获。
set -euo pipefail

BASE="${HEALTH_URL:-http://127.0.0.1:3000/health}"
MIN_FREE_PCT="${DISK_MIN_FREE_PCT:-10}"
REQUIRE_REDIS="${REQUIRE_REDIS:-1}"

if ! command -v curl >/dev/null 2>&1; then
  echo "healthcheck: 缺少 curl" >&2
  exit 1
fi

if ! body="$(curl -fsS --max-time 5 "$BASE")"; then
  echo "healthcheck: $BASE 请求失败" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "healthcheck: 缺少 node" >&2
  exit 1
fi

node - "$body" "$MIN_FREE_PCT" "$REQUIRE_REDIS" <<'NODE'
const [raw, minPctRaw, requireRedisRaw] = process.argv.slice(2);
const minPct = Number(minPctRaw);
const requireRedis = requireRedisRaw === '1';
let health;
try {
  health = JSON.parse(raw);
} catch {
  console.error('healthcheck: /health 不是合法 JSON');
  process.exit(1);
}
const fail = [];
if (health.ok !== true) fail.push('ok != true');
const backends = health.backends || {};
if (backends.user !== 'mysql') fail.push(`user=${backends.user}`);
if (backends.chat !== 'mysql') fail.push(`chat=${backends.chat}`);
if (requireRedis && backends.session !== 'redis') fail.push(`session=${backends.session}`);
if (health.files?.mode !== 'local') fail.push(`files.mode=${health.files?.mode}`);
if (!health.relay?.upstreamConfigured) fail.push('upstream 未配置');
const disk = health.files?.disk;
if (disk && Number.isFinite(minPct)) {
  const freePct = 100 - Number(disk.usedPct);
  if (freePct < minPct) fail.push(`磁盘剩余 ${freePct.toFixed(1)}% < ${minPct}%`);
}
if (fail.length) {
  console.error(`healthcheck: 异常：${fail.join('；')}`);
  process.exit(1);
}
const mem = health.process?.rssBytes;
const diskText = disk ? `磁盘剩余 ${(100 - disk.usedPct).toFixed(1)}%` : '磁盘未知';
console.log(
  `healthcheck: ok  ${diskText}  RSS ${mem ? Math.round(mem / 1024 / 1024) + 'M' : '?'}  upstream=${health.relay.upstream}`
);
NODE

# 进程本身应处于 active；timer 失败通常意味着服务已挂
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet auth-demo; then
    echo "healthcheck: auth-demo.service 不是 active" >&2
    exit 1
  fi
fi

exit 0
