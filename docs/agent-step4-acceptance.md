# 第 4 步：上线验收与灰度操作手册（Agent 阶段 1）

> 适用范围：Agent 阶段 1（任务创建、查询、取消、落库排队）。
>
> 本步不需要修改业务代码。模型循环、Docker 隔离、输出文件上传、Chat 端轮询属于阶段 2/3/4，本手册中标记为 N/A。

## 1. 验收准备

1. 确认第 3 步已完成，`/health` 返回：

```bash
curl -sS https://api.shunkai-dg.cn/health | jq '.agent'
# { "enabled": true, "queueMode": "off", "executionEnabled": false, "allowlistSize": 1 }
```

2. 查测试用户 ID，并确保它在 `AGENT_ALLOWLIST` 中：

```bash
cd /opt/auth-demo
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/admin.js list
```

3. 准备一个不在名单内的普通账号，用于验证 403。

4. 登录方式二选一：

**方式 A：浏览器 + curl（推荐人工验收）**

- 浏览器登录 `https://chat.shunkai-dg.cn`。
- DevTools → Application → Cookies，复制 `authdemo.session` 的值（HttpOnly Cookie 仍可在 DevTools 看到）。
- 设置变量：

```bash
BASE=https://api.shunkai-dg.cn
ORIGIN=https://api.shunkai-dg.cn
COOKIE='把 cookie 值粘贴到这里'
```

**方式 B：临时 Node 脚本（推荐自动验收）**

在 `/opt/auth-demo` 下执行第 7 节的 heredoc 脚本，脚本会自动完成登录、创建、轮询、取消与断言。

## 2. 验收用例清单

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| A-01 | 未登录创建任务 | `401 TOKEN_MISSING` |
| A-02 | 名单外用户创建任务 | `403 AGENT_NOT_ALLOWED` |
| A-03 | 名单内用户创建任务 | `202`，`status=queued`，返回 `task_id` |
| A-04 | 轮询任务 | `200`，状态 `queued`，`files=[]` |
| A-05 | 查询步骤 | `200`，`steps=[]` |
| A-06 | 取消任务 | `200`，`cancelled=true`，状态 `cancelled` |
| A-07 | 重复取消 | `200`，`cancelled=false` |
| A-08 | 同一用户相同幂等键重复创建 | 返回同一个 `task_id` |
| A-09 | 其他用户访问该任务 | `404 AGENT_TASK_NOT_FOUND` |
| A-10 | 引用其他用户的文件 | `404 FILE_ACCESS_DENIED` |
| A-11 | 空消息 / 非法字段 | `400 INVALID_INPUT` |
| A-12 | 消息超过 12KB | `413 PAYLOAD_TOO_LARGE` |
| A-13 | 关闭总开关（仅预发验证） | `503 AGENT_DISABLED` |
| A-14 | 队列模式为 off | 任务保持 `queued`，Redis 无 `agent:` 任务键，无 Worker 消费 |

## 3. curl 验收命令

> `Origin` 必须与请求 Host 同源，或落在 `CORS_ORIGINS` 白名单；否则 CSRF 会返回 403。

创建任务：

```bash
curl -sS -X POST "$BASE/api/agent/tasks" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: accept-20261127-001' \
  -d '{"message":"验收：创建一个空任务"}' | tee /tmp/agent-create.json | jq
```

记录返回的 `task_id`：

```bash
TASK_ID=$(jq -r '.task_id' /tmp/agent-create.json)
echo "$TASK_ID"
```

轮询任务：

```bash
curl -sS "$BASE/api/agent/tasks/$TASK_ID" \
  -b "authdemo.session=$COOKIE" | jq
```

查询步骤：

```bash
curl -sS "$BASE/api/agent/tasks/$TASK_ID/steps" \
  -b "authdemo.session=$COOKIE" | jq
```

取消任务：

```bash
curl -sS -X POST "$BASE/api/agent/tasks/$TASK_ID/cancel" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" | jq
```

重复取消：

```bash
curl -sS -X POST "$BASE/api/agent/tasks/$TASK_ID/cancel" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" | jq '.cancelled'   # false
```

幂等重复创建：

```bash
curl -sS -X POST "$BASE/api/agent/tasks" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: accept-20261127-001' \
  -d '{"message":"验收：创建一个空任务"}' | jq -r '.task_id'
# 应与第一次的 TASK_ID 相同
```

未登录：

```bash
curl -sS -o /tmp/anon.json -w '%{http_code}\n' \
  -X POST "$BASE/api/agent/tasks" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"hi"}'
# 401；响应 code=TOKEN_MISSING
```

非法输入：

```bash
curl -sS -o /tmp/bad.json -w '%{http_code}\n' \
  -X POST "$BASE/api/agent/tasks" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"   "}'
# 400；code=INVALID_INPUT
```

## 4. 双账号与文件隔离用例（A-02 / A-09 / A-10）

准备两个辅助账号：

- **账号 B**：也在 `AGENT_ALLOWLIST` 中。用于跨用户 404 和他人文件引用验证；如果 B 不在名单内，会先被 403 拦住，测不到 404。
- **账号 C**：不在 `AGENT_ALLOWLIST` 中。用于验证 403。

分别登录后复制 Cookie：

```bash
COOKIE_B='账号 B 的 cookie 值'
COOKIE_C='账号 C 的 cookie 值'
```

名单外账号 C 创建任务，期望 `403 AGENT_NOT_ALLOWED`：

```bash
curl -sS -o /tmp/not-allowed.json -w '%{http_code}\n' \
  -X POST "$BASE/api/agent/tasks" \
  -b "authdemo.session=$COOKIE_C" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"hi"}'
jq . /tmp/not-allowed.json
```

用账号 B 上传文件（走现有附件接口），用于验证跨用户文件引用。若 `FILES_MODE=off`，本项跳过：

```bash
printf 'a,b\n1,2\n' > /tmp/other.csv
curl -sS -X POST "$BASE/v1/files/originals" \
  -b "authdemo.session=$COOKIE_B" \
  -H "Origin: $ORIGIN" \
  -H 'X-File-Name: other.csv' \
  -H 'X-File-Mime: text/csv' \
  --data-binary @/tmp/other.csv | tee /tmp/other-file.json | jq
```

用第一个账号引用账号 B 的 `fileId`，期望 `404 FILE_ACCESS_DENIED`：

```bash
FILE_ID_B=$(jq -r '.fileId' /tmp/other-file.json)

curl -sS -o /tmp/file-denied.json -w '%{http_code}\n' \
  -X POST "$BASE/api/agent/tasks" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -d "{\"message\":\"读取他人文件\",\"file_ids\":[\"$FILE_ID_B\"]}"
jq . /tmp/file-denied.json
```

跨用户查询任务（用账号 B 的 Cookie 访问第一个账号的 `TASK_ID`），期望 `404 AGENT_TASK_NOT_FOUND`：

```bash
curl -sS -o /tmp/task-denied.json -w '%{http_code}\n' \
  "$BASE/api/agent/tasks/$TASK_ID" \
  -b "authdemo.session=$COOKIE_B"
jq . /tmp/task-denied.json
```

## 5. SQL 验收

```bash
mysql -u root -p auth_demo -e "
  SELECT id, user_id, status, current_step, created_at
    FROM agent_tasks ORDER BY created_at DESC LIMIT 5;

  SELECT task_id, step_index, step_type, tool_name, status
    FROM agent_task_steps ORDER BY id DESC LIMIT 10;

  SELECT task_id, file_role, file_name, file_size
    FROM agent_task_files ORDER BY created_at DESC LIMIT 10;
"
```

期望：

- 新建任务在 `agent_tasks` 中存在，`status=queued`（取消后为 `cancelled`）。
- 阶段 1 没有 Worker，`agent_task_steps` 应为空。
- 纯文本任务 `agent_task_files` 为空；带附件任务应只有 `file_role=input` 的快照。
- 同一用户同一幂等键只有一条记录。

检查队列未被消费：

```bash
systemctl status auth-demo-agent-worker --no-pager 2>/dev/null || echo 'worker 未安装（阶段 1 预期）'
set -a; . /etc/auth-demo/env; set +a
redis-cli -u "$REDIS_URL" --scan --pattern 'agent:*' | head
# 期望：无输出（queueMode=off）
```

## 6. 灰度步骤

1. 只把 1 个测试用户 ID 放入 `/etc/auth-demo/env`：

```dotenv
AGENT_ALLOWLIST=123
```

2. 重启 API：

```bash
systemctl restart auth-demo
```

3. 用该用户执行第 2 节 A-03 ~ A-10。
4. 观察 24 小时：

```bash
# 任务状态分布
mysql -u root -p auth_demo -e "
  SELECT status, COUNT(*) AS n FROM agent_tasks GROUP BY status;
"

# 最近错误日志
journalctl -u auth-demo --since '24 hours ago' --no-pager | grep -E '\[agent\]|unhandled' || true

# HTTP 5xx（Nginx 日志）
grep ' 5[0-9][0-9] ' /var/log/nginx/api.access.log | tail -50
```

5. 无异常后逐步扩大 `AGENT_ALLOWLIST`，每次重启 API。
6. **阶段 1 不要开启** `AGENT_EXECUTION_ENABLED` 或 `AGENT_QUEUE_MODE=bullmq`；否则任务会被投递，但执行器尚未实现。

## 7. 自动验收入口（临时脚本，不写入仓库）

在 `/opt/auth-demo` 下执行：

```bash
BASE=https://api.shunkai-dg.cn \
AGENT_TEST_USER=alice \
AGENT_TEST_PASS='Alice@Passw0rd' \
node <<'NODE'
const crypto = require('node:crypto');
const { createClient } = require('./scripts/_client');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.AGENT_TEST_USER || 'alice';
const PASS = process.env.AGENT_TEST_PASS || 'Alice@Passw0rd';
const KEY = `accept-${Date.now()}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  const client = createClient(BASE);
  const pk = await client.call('GET', '/auth/public-key');
  if (pk.status !== 200) throw new Error(`public-key ${pk.status}`);

  const ub = Buffer.from(USER, 'utf8');
  const payload = Buffer.concat([
    Buffer.from(`v1\n${ub.length}\n`, 'utf8'), ub, Buffer.from(PASS, 'utf8'),
  ]).toString('utf8');
  const encrypted = crypto.publicEncrypt(
    { key: pk.body.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: pk.body.oaepHash },
    Buffer.from(payload, 'utf8')
  ).toString('base64');

  const login = await client.call('POST', '/auth/login', { body: { encrypted } });
  check('登录成功', login.status === 200, `status=${login.status}`);
  if (login.status !== 200) throw new Error('登录失败，检查测试账号/密码');

  const health = await client.call('GET', '/health');
  check('Agent 已开启', health.status === 200 && health.body.agent && health.body.agent.enabled === true);

  const created = await client.call('POST', '/api/agent/tasks', {
    headers: { 'idempotency-key': KEY },
    body: { message: '自动验收：创建任务' },
  });
  check('创建任务 202', created.status === 202, JSON.stringify(created.body));
  check('状态为 queued', created.body && created.body.status === 'queued');
  const taskId = created.body && created.body.task_id;
  if (!taskId) throw new Error('缺少 task_id');

  const again = await client.call('POST', '/api/agent/tasks', {
    headers: { 'idempotency-key': KEY },
    body: { message: '自动验收：创建任务' },
  });
  check('幂等键返回同一任务', again.status === 202 && again.body && again.body.task_id === taskId);

  const fetched = await client.call('GET', `/api/agent/tasks/${taskId}`);
  check('查询任务 200', fetched.status === 200 && fetched.body && fetched.body.task_id === taskId);

  const steps = await client.call('GET', `/api/agent/tasks/${taskId}/steps`);
  check('阶段 1 无执行步骤', steps.status === 200 && steps.body && Array.isArray(steps.body.steps) && steps.body.steps.length === 0);

  const cancelled = await client.call('POST', `/api/agent/tasks/${taskId}/cancel`);
  check('取消成功', cancelled.status === 200 && cancelled.body && cancelled.body.cancelled === true);

  const cancelledAgain = await client.call('POST', `/api/agent/tasks/${taskId}/cancel`);
  check('重复取消 cancelled=false', cancelledAgain.status === 200 && cancelledAgain.body && cancelledAgain.body.cancelled === false);

  const anon = createClient(BASE);
  const noAuth = await anon.call('POST', '/api/agent/tasks', { body: { message: 'hi' } });
  check('未登录 401', noAuth.status === 401 && noAuth.body && noAuth.body.code === 'TOKEN_MISSING');

  const bad = await client.call('POST', '/api/agent/tasks', { body: { message: '   ' } });
  check('空消息 400', bad.status === 400 && bad.body && bad.body.code === 'INVALID_INPUT');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
NODE
```

脚本说明：

- 登录使用现有 `/auth/public-key` 与 RSA-OAEP，不绕过认证。
- `createClient` 自动维护 Cookie、自动带 `Origin`，符合 CSRF 要求。
- 只创建/查询/取消任务，不触发模型或脚本。
- 如果测试账号不在 `AGENT_ALLOWLIST`，创建用例会返回 403，先调整名单。

## 8. 阶段 1 验收判定

可以判定通过：

- [ ] A-01 ~ A-12 全部符合预期。
- [ ] 三张表结构、索引正确，任务/文件按用户隔离。
- [ ] 任务状态、幂等键、取消语义正确。
- [ ] 队列模式为 off 时任务保持 `queued`，无 Worker 消费。
- [ ] 现有 Chat / 登录 / 附件回归正常。

本阶段不适用（标记 N/A，留到后续阶段）：

- Anthropic `tool_use` / `tool_result` 循环。
- 600 秒任务超时自动终止。
- Docker 容器隔离、断网、资源限制、脚本超时杀进程。
- 输出文件归档、下载链接与配额。
- Chat 端轮询与结果展示。

## 9. 回滚与异常处理

| 现象 | 处理 |
| --- | --- |
| `/api/agent/*` 返回 503 `AGENT_DISABLED` | 检查 `AGENT_ENABLED`，重启 API |
| 名单内用户仍 403 | 检查 `AGENT_ALLOWLIST` 是否为数字用户 ID，重启 API |
| 创建任务返回 500 | 检查 MySQL 表是否存在、应用账号权限、`journalctl -u auth-demo` |
| 创建任务成功但一直 `queued` | 阶段 1 预期行为；确认 `AGENT_QUEUE_MODE=off`、未启动 Worker |
| 需要紧急关闭 | `AGENT_ENABLED=0` → `systemctl restart auth-demo`；保留表和数据 |
| 需要清理验收数据 | 按 `task_id` 删除任务，步骤/文件随外键级联删除 |

```sql
DELETE FROM agent_tasks WHERE id = '验收任务ID';
```
