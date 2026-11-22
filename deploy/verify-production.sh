#!/usr/bin/env bash
# 生产验收：健康、首页、TLS、CORS、安全头。
# 用法：API_BASE=https://api.example.com WEB_BASE=https://chat.example.com ./deploy/verify-production.sh
# 内网自签证书调试可设 SKIP_TLS=1。
set -euo pipefail

API_BASE="${API_BASE:-https://api.shunkai-dg.cn}"
WEB_BASE="${WEB_BASE:-https://chat.shunkai-dg.cn}"
WEB_ORIGIN="${WEB_ORIGIN:-$WEB_BASE}"
SKIP_TLS="${SKIP_TLS:-0}"
fail=0
pass() { printf '  PASS  %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

command -v curl >/dev/null || { echo '需要 curl'; exit 2; }
command -v node >/dev/null || { echo '需要 node'; exit 2; }

echo "验收目标：API=$API_BASE  WEB=$WEB_BASE"

echo '[1] /health'
health="$(curl -fsS --max-time 10 "$API_BASE/health")" || { bad "$API_BASE/health 请求失败"; health=''; }
if [ -n "$health" ]; then
  if node - "$health" <<'NODE'
const h = JSON.parse(process.argv[2]);
const problems = [];
if (h.ok !== true) problems.push('ok != true');
if (h.env !== 'production') problems.push(`env=${h.env}`);
if (h.backends?.user !== 'mysql') problems.push(`user=${h.backends?.user}`);
if (h.backends?.session !== 'redis') problems.push(`session=${h.backends?.session}`);
if (h.backends?.chat !== 'mysql') problems.push(`chat=${h.backends?.chat}`);
if (h.files?.mode !== 'local') problems.push(`files=${h.files?.mode}`);
if (!h.relay?.upstreamConfigured) problems.push('upstream 未配置');
if (h.files?.disk && h.files.disk.usedPct >= 90) problems.push(`磁盘已用 ${h.files.disk.usedPct}%`);
if (problems.length) {
  console.error('        ' + problems.join('；'));
  process.exit(1);
}
console.log(`        ${h.process?.node}  RSS ${Math.round((h.process?.rssBytes || 0) / 1048576)}M  磁盘已用 ${h.files?.disk?.usedPct ?? '?'}%`);
NODE
  then pass '/health 后端与磁盘正常'; else bad '/health 内容异常'; fi
fi

echo '[2] 前端首页'
html="$(curl -fsS --max-time 10 "$WEB_BASE/")" || { bad "$WEB_BASE 请求失败"; html=''; }
if [ -n "$html" ]; then
  if printf '%s' "$html" | grep -q 'id="root"'; then pass '首页返回应用入口'; else bad '首页缺少 #root'; fi
fi
headers="$(curl -fsSI --max-time 10 "$WEB_BASE/" || true)"
printf '%s' "$headers" | grep -qi 'content-security-policy:' && pass 'CSP 已设置' || bad '缺少 CSP'
printf '%s' "$headers" | grep -qi 'strict-transport-security:' && pass 'HSTS 已设置' || bad '缺少 HSTS'

echo '[3] API 可达'
if curl -fsS --max-time 10 "$API_BASE/auth/public-key" | grep -q 'BEGIN PUBLIC KEY'; then
  pass '公钥接口正常'
else
  bad '公钥接口异常'
fi

echo '[4] CORS 预检'
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
code="$(curl -sS -D "$tmp" -o /dev/null -w '%{http_code}' --max-time 10 \
  -X OPTIONS \
  -H "Origin: $WEB_ORIGIN" \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: authorization' \
  "$API_BASE/auth/me")"
if [ "$code" = '204' ] && grep -qi "^access-control-allow-origin: $WEB_ORIGIN" "$tmp" \
  && grep -qi '^access-control-allow-methods:.*PUT' "$tmp"; then
  pass '跨域预检通过（含 PUT）'
else
  bad "跨域预检异常（status=$code）"
fi

if [ "$SKIP_TLS" != '1' ]; then
  echo '[5] TLS 证书'
  for host in "${API_BASE#*://}" "${WEB_BASE#*://}"; do
    host="${host%%/*}"
    if echo | openssl s_client -servername "$host" -connect "$host:443" >/dev/null 2>&1 \
      && echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
        | openssl x509 -noout -checkend 1209600 >/dev/null 2>&1; then
      pass "$host 证书 14 天内不过期"
    else
      bad "$host 证书无效或 14 天内过期"
    fi
  done
fi

echo
if [ "$fail" = '0' ]; then
  echo '验收通过'
else
  echo '验收失败'
fi
exit "$fail"
