# 第 3 步：生产部署操作手册（Agent 阶段 1）

> 适用范围：只部署“任务基础设施”（建表、API、功能开关）。本阶段 **不启动 Worker、不调用模型、不执行 Docker**。
>
> 本步不需要修改业务代码；如果后续开启阶段 2/3（模型循环、Docker 执行器），才需要继续开发并调整 Worker 配置。

## 1. 前置检查

在服务器上执行：

```bash
node -v                 # 需要 Node 20（CentOS 7 见 deploy/centos7-node20.md）
npm -v
systemctl status mysqld redis nginx --no-pager
```

确认：

- 现有 auth-demo 已正常部署，`/health` 返回 200。
- `PEPPER`、RSA 私钥/公钥已按现有方式注入。
- `MYSQL_URL`、`REDIS_URL` 可用。
- 已备份数据库：

```bash
mysqldump --single-transaction --routines --triggers \
  -u root -p auth_demo > /var/backups/auth-demo/before-agent-$(date +%F-%H%M).sql
```

## 2. 部署代码与依赖

```bash
cd /opt/auth-demo
# 按现有发布流程同步代码后：
npm ci --omit=dev
```

确认依赖包含 BullMQ：

```bash
npm ls bullmq ioredis --depth=0
```

如果使用构建产物（`npm run build` 后的 `dist/`），确认 `dist/src/modules/agent/` 与 `dist/src/workers/agent.worker.js` 存在。

## 3. 执行数据库迁移

生产环境用 `ENV_FILE` 复用 systemd 的环境文件，不要用 `npm run migrate`（该脚本带 `--database`，会额外要求应用账号具备全局 `CREATE DATABASE` 权限）：

```bash
cd /opt/auth-demo
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/migrate.js
```

迁移脚本会按文件名顺序执行 `migrations/*.sql`，`005_agent.sql` 使用 `CREATE TABLE IF NOT EXISTS`，可重复执行。

> 如果数据库尚未创建，先用有全局 `CREATE` 权限的账号执行一次：
>
> ```bash
> ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/migrate.js --database
> ```
>
> 数据库已存在时不要加 `--database`。

验证表结构：

```bash
mysql -u root -p auth_demo -e "
  SHOW TABLES LIKE 'agent_%';
  SHOW CREATE TABLE agent_tasks\G
  SHOW CREATE TABLE agent_task_steps\G
  SHOW CREATE TABLE agent_task_files\G
"
```

期望看到三张表：

- `agent_tasks`
- `agent_task_steps`
- `agent_task_files`

检查关键索引：

```sql
SHOW INDEX FROM agent_tasks;
-- 应包含 uk_agent_tasks_user_idem (user_id, idempotency_key)
-- 以及 idx_agent_tasks_user_created / idx_agent_tasks_status_created

SHOW INDEX FROM agent_task_steps;
-- 应包含 uk_agent_steps_task_index (task_id, step_index)
```

数据库账号权限：应用账号至少需要这三张表的 `SELECT / INSERT / UPDATE / DELETE`；迁移账号需要 `CREATE / ALTER / INDEX / REFERENCES`。

> 回滚说明：阶段 1 建议只关闭功能开关，不删表。确需删除且确认无数据时：
>
> ```sql
> DROP TABLE IF EXISTS agent_task_files;
> DROP TABLE IF EXISTS agent_task_steps;
> DROP TABLE IF EXISTS agent_tasks;
> ```

## 4. 配置环境变量

编辑 `/etc/auth-demo/env`（保持 `600 root:authsvc`），追加阶段 1 配置：

```dotenv
# ---- Agent Harness：阶段 1 只落库排队 ----
AGENT_ENABLED=1
AGENT_ALLOWLIST=1
AGENT_EXECUTION_ENABLED=0
AGENT_QUEUE_MODE=off
AGENT_WORKSPACE_DIR=/var/lib/auth-demo-agent
AGENT_MYSQL_POOL_SIZE=4
AGENT_TASK_TIMEOUT_MS=600000
AGENT_SCRIPT_TIMEOUT_MS=120000
AGENT_MAX_OUTPUT_FILES=10
AGENT_USER_QUOTA_BYTES=21474836480
```

说明：

- `AGENT_ALLOWLIST` 填测试用户的数字 ID（用 `npm run user:list` 查询）；留空表示所有已登录用户可用，生产灰度阶段不建议留空。
- 阶段 1 必须保持 `AGENT_EXECUTION_ENABLED=0`、`AGENT_QUEUE_MODE=off`。
- `AGENT_WORKSPACE_DIR` 阶段 1 不会写入，提前创建是为了阶段 2/3 的 Worker。
- 其余限制项可参考 `deploy/env.production.example`，保持默认即可。

## 5. 准备 Worker 账号与目录（阶段 2/3 使用，阶段 1 不启动）

阶段 1 不需要 Worker，但可以提前准备独立账号，避免后续临时改权限：

```bash
# 独立系统账号，不允许登录
useradd --system --home-dir /var/lib/auth-demo-agent --shell /sbin/nologin agentworker

# 工作目录：仅 Worker 可写，API 不需要访问
install -d -o agentworker -g agentworker -m 0750 /var/lib/auth-demo-agent
```

安全要求：

- **不要**把 `agentworker` 加入 `docker` 组。
- **不要**把 `/var/run/docker.sock` 挂载或授权给 Worker。
- 后续 Docker 调用必须通过 root 控制的 launcher/代理完成（阶段 3）。
- Worker 的 EnvironmentFile 单独放 `/etc/auth-demo/agent-worker.env`，权限 `640 root:agentworker`，只放它需要的变量。

阶段 2/3 再创建 `/etc/systemd/system/auth-demo-agent-worker.service`，参考模板：

```ini
[Unit]
Description=auth-demo Agent Worker (BullMQ)
After=network-online.target mysqld.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=agentworker
Group=agentworker
WorkingDirectory=/opt/auth-demo
EnvironmentFile=/etc/auth-demo/agent-worker.env
Environment=NODE_ENV=production
Environment=AGENT_WORKSPACE_DIR=/var/lib/auth-demo-agent
ExecStart=/opt/node/bin/node --max-old-space-size=384 src/workers/agent.worker.js

Restart=on-failure
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=65535

# 与 API 进程隔离；只允许访问自己的工作目录
StateDirectory=auth-demo-agent
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

阶段 2/3 的 Worker 环境变量至少包含：

```dotenv
AGENT_ENABLED=1
AGENT_EXECUTION_ENABLED=1
AGENT_QUEUE_MODE=bullmq
AGENT_WORKER_CONCURRENCY=1
MYSQL_URL=...
REDIS_URL=...
UPSTREAM_BASE_URL=...
UPSTREAM_API_KEY=...
UPSTREAM_MESSAGES_PATH=/anthropic/v1/messages
```

> 阶段 1 不要 `systemctl enable/start auth-demo-agent-worker`。当前 Worker 入口在 `AGENT_EXECUTION_ENABLED=0` 时会主动拒绝启动，这是预期行为。

## 6. 重启 API 并检查

```bash
systemctl daemon-reload
systemctl restart auth-demo
sleep 2
systemctl status auth-demo --no-pager
journalctl -u auth-demo -n 80 --no-pager
```

检查启动日志应包含：

```text
Agent     : enabled (queue=off, executor=off)
```

检查健康接口（如服务器没有 `jq`，先 `yum install -y jq`，或去掉 `| jq '.agent'`）：

```bash
curl -sS https://api.shunkai-dg.cn/health | jq '.agent'
```

期望：

```json
{
  "enabled": true,
  "queueMode": "off",
  "executionEnabled": false,
  "allowlistSize": 1
}
```

## 7. Nginx / CORS / CSRF

- Agent 路由是 `/api/agent/*`，现有 `location /` 已反代到 `127.0.0.1:3000`，**一般不需要改 Nginx**。
- 阶段 1 的请求体是小型 JSON，`client_max_body_size 1m` 足够；附件仍走现有 `/v1/files` 上传。
- 如果前端与 API 分域部署，确认 `/etc/auth-demo/env` 的 `CORS_ORIGINS` 包含前端来源（如 `https://chat.shunkai-dg.cn`）。
- 状态变更请求（创建/取消）必须带合法 `Origin`；浏览器会自动带，CLI 验收时需手动加。
- CORS 已允许 `Idempotency-Key` 请求头，无需额外配置。

## 8. 阶段 1 回滚

最快回滚：关闭功能开关，不删表、不回滚代码。

```bash
sed -i 's/^AGENT_ENABLED=.*/AGENT_ENABLED=0/' /etc/auth-demo/env
systemctl restart auth-demo
```

回滚后：

- `/api/agent/*` 返回 `503 AGENT_DISABLED`。
- 已创建任务仍保留在 MySQL，不丢数据。
- 现有 Chat / 登录 / 附件不受影响。

如需完全回滚代码，回退版本后保留表即可；旧代码不会访问这些表。

## 9. 验收交接

部署完成后，按《第 4 步：上线验收与灰度操作手册》执行验收：

- [ ] 三张表存在，索引正确
- [ ] `/health` 显示 Agent enabled / queue=off / executor=off
- [ ] 允许名单内用户可以创建任务并轮询
- [ ] 名单外用户返回 403
- [ ] 未登录返回 401
- [ ] 任务创建后保持 `queued`，没有 Worker 消费
- [ ] 现有 Chat / 登录 / 附件功能回归正常
