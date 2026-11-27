# Agent 阶段 1 上线执行单

> 用途：一次性完成 Agent 阶段 1 的生产上线。
>
> 目标状态：`AGENT_ENABLED=1`、`AGENT_EXECUTION_ENABLED=0`、`AGENT_QUEUE_MODE=off`。
> **不启动 Worker、不调用模型、不执行 Docker。**

## 0. 本次构建与预演结果

- 构建包：`C:\NewCachePath\opencode\deploy\auth-demo-dist-2026-11-27.tar.gz`
- 大小：187,483 字节
- SHA256：`A333A5857475D9572E3C9F15B01C99C1EB71649F298B80346EC572960B41BDD9`
- 本地预演：
  - MySQL 5.7.38 迁移成功（001–005）
  - MySQL 仓储集成验收 12/12 PASS
  - MySQL + Redis + HTTP 全链路验收 11/11 PASS
  - 验收数据与临时账号已清理

## 1. 上传构建包

在 Windows 构建机执行（把 `SERVER` 换成生产服务器地址）：

```powershell
scp C:\NewCachePath\opencode\deploy\auth-demo-dist-2026-11-27.tar.gz root@SERVER:/tmp/
```

服务器上校验：

```bash
cd /tmp
sha256sum auth-demo-dist-2026-11-27.tar.gz
# 应为 A333A5857475D9572E3C9F15B01C99C1EB71649F298B80346EC572960B41BDD9
```

## 2. 备份

```bash
# 代码备份
rm -rf /opt/auth-demo.prev
cp -a /opt/auth-demo /opt/auth-demo.prev

# 数据库备份（按实际库名/账号调整）
mysqldump --single-transaction --routines --triggers \
  -u root -p auth_demo > /var/backups/auth-demo/before-agent-$(date +%F-%H%M).sql

ls -lh /var/backups/auth-demo/ | tail -3
```

## 3. 解包与依赖

```bash
rm -rf /opt/auth-demo
mkdir -p /opt/auth-demo
tar -xzf /tmp/auth-demo-dist-2026-11-27.tar.gz -C /opt/auth-demo

cd /opt/auth-demo
/opt/node/bin/npm ci --omit=dev
chmod +x deploy/*.sh

node -v          # 需要 Node 20
npm ls bullmq ioredis --depth=0
```

确认新代码存在：

```bash
test -f src/modules/agent/index.js
test -f src/workers/agent.worker.js
test -f migrations/005_agent.sql
```

## 4. 执行迁移

```bash
cd /opt/auth-demo
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/migrate.js
```

> 不要用 `npm run migrate`：它带 `--database`，会要求应用账号具备全局 `CREATE DATABASE` 权限。
> 数据库已存在时，使用上面的 `ENV_FILE=... scripts/migrate.js` 即可。

## 5. 校验表与索引

```bash
mysql -u root -p auth_demo -e "
  SHOW TABLES LIKE 'agent_%';
  SHOW INDEX FROM agent_tasks;
  SHOW INDEX FROM agent_task_steps;
  SHOW INDEX FROM agent_task_files;
"
```

期望三张表：

- `agent_tasks`
- `agent_task_steps`
- `agent_task_files`

`agent_tasks` 应包含：

- `PRIMARY (id)`
- `uk_agent_tasks_user_idem UNIQUE (user_id, idempotency_key)`
- `idx_agent_tasks_user_created (user_id, created_at)`
- `idx_agent_tasks_status_created (status, created_at)`

`agent_task_steps` 应包含：

- `uk_agent_steps_task_index UNIQUE (task_id, step_index)`

## 6. 配置环境变量

```bash
sudoedit /etc/auth-demo/env
```

确认/追加：

```dotenv
AGENT_ENABLED=1
AGENT_ALLOWLIST=123
AGENT_EXECUTION_ENABLED=0
AGENT_QUEUE_MODE=off
AGENT_WORKSPACE_DIR=/var/lib/auth-demo-agent
AGENT_MYSQL_POOL_SIZE=4
```

把 `123` 换成测试用户的数字 ID。查 ID：

```bash
cd /opt/auth-demo
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/admin.js list
```

注意：

- `AGENT_ALLOWLIST` 留空表示所有已登录用户可用，生产灰度阶段不建议留空。
- 阶段 1 必须保持 `AGENT_EXECUTION_ENABLED=0`、`AGENT_QUEUE_MODE=off`。
- 不要启动 `auth-demo-agent-worker`。

## 7. 重启 API 并检查

```bash
systemctl restart auth-demo
sleep 2
systemctl status auth-demo --no-pager
journalctl -u auth-demo -n 80 --no-pager
```

启动日志应包含：

```text
Agent     : enabled (queue=off, executor=off)
```

健康检查：

```bash
curl -sS https://api.shunkai-dg.cn/health
```

重点确认：

```json
{
  "agent": {
    "enabled": true,
    "queueMode": "off",
    "executionEnabled": false
  }
}
```

## 8. 生产验收

### 8.1 获取测试账号 Cookie（推荐）

浏览器登录 `https://chat.shunkai-dg.cn`，DevTools → Application → Cookies，复制 `authdemo.session`：

```bash
BASE=https://api.shunkai-dg.cn
ORIGIN=https://api.shunkai-dg.cn
COOKIE='粘贴 authdemo.session 的值'
```

### 8.2 创建任务

```bash
curl -sS -X POST "$BASE/api/agent/tasks" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: prod-accept-20261127-001' \
  -d '{"message":"生产验收：创建一个空任务"}' \
  | tee /tmp/agent-create.json
```

期望：HTTP 202，`status=queued`，返回 `task_id`。

### 8.3 轮询与取消

```bash
TASK_ID=$(sed -n 's/.*"task_id":"\([^"]*\)".*/\1/p' /tmp/agent-create.json)
echo "$TASK_ID"

curl -sS "$BASE/api/agent/tasks/$TASK_ID" -b "authdemo.session=$COOKIE"
curl -sS "$BASE/api/agent/tasks/$TASK_ID/steps" -b "authdemo.session=$COOKIE"

curl -sS -X POST "$BASE/api/agent/tasks/$TASK_ID/cancel" \
  -b "authdemo.session=$COOKIE" \
  -H "Origin: $ORIGIN"
```

期望：

- 查询返回 `status=queued`
- `steps=[]`
- 取消返回 `cancelled=true`，状态变为 `cancelled`
- 再取消一次返回 `cancelled=false`

### 8.4 SQL 检查

```bash
mysql -u root -p auth_demo -e "
  SELECT id, user_id, status, created_at
    FROM agent_tasks ORDER BY created_at DESC LIMIT 5;

  SELECT COUNT(*) AS steps FROM agent_task_steps;
  SELECT COUNT(*) AS files FROM agent_task_files;
"
```

阶段 1 没有 Worker，`agent_task_steps` 应为空。

### 8.5 确认 Worker 未启动

```bash
systemctl status auth-demo-agent-worker --no-pager 2>/dev/null || echo 'worker 未安装（阶段 1 预期）'
```

## 9. 回滚

### 9.1 只关闭 Agent（最快，保留数据）

```bash
sudoedit /etc/auth-demo/env
# 改为 AGENT_ENABLED=0
systemctl restart auth-demo
```

回滚后 `/api/agent/*` 返回 `503 AGENT_DISABLED`，任务数据保留，Chat/登录/附件不受影响。

### 9.2 回滚代码

```bash
systemctl stop auth-demo
rm -rf /opt/auth-demo
mv /opt/auth-demo.prev /opt/auth-demo
systemctl start auth-demo
```

数据库表可以保留，旧代码不会访问。

## 10. 上线后观察

```bash
# 任务状态分布
mysql -u root -p auth_demo -e "
  SELECT status, COUNT(*) AS n FROM agent_tasks GROUP BY status;
"

# 最近异常
journalctl -u auth-demo --since '30 minutes ago' --no-pager | grep -E '\[agent\]|unhandled|启动失败' || true

# Nginx 5xx
grep ' 5[0-9][0-9] ' /var/log/nginx/api.access.log | tail -20
```

阶段 1 的预期：

- 任务保持 `queued` 或 `cancelled`。
- 没有 Worker 进程。
- Redis 中不应出现 `agent:` 队列键。
- 不需要修改 Nginx。

## 11. 上线完成判定

- [ ] `005_agent.sql` 已执行，三张表与索引正确
- [ ] `/health` 显示 Agent enabled / queue=off / executor=off
- [ ] 名单内用户创建任务返回 202
- [ ] 查询、步骤、取消接口正常
- [ ] 名单外用户 403，未登录 401
- [ ] 任务保持 queued，无 Worker 消费
- [ ] Chat / 登录 / 附件回归正常
- [ ] 已记录测试任务 `task_id` 和回滚开关位置
