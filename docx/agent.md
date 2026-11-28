# Agent Harness（阶段 1：任务基础设施）

本阶段只落地“任务能安全创建、持久化、查询和取消”的基础设施，**不调用模型、不执行脚本、不创建 Docker 容器**。Chat / 登录 / 附件原有链路未改动。

## 1. 开关与前置条件

Agent 默认关闭，需显式配置：

```dotenv
AGENT_ENABLED=1
# 可选：只对这些用户开放；留空 = 所有已登录用户
AGENT_ALLOWLIST=1,2
# 阶段 1 必须为 0，避免任务被消费后直接失败
AGENT_EXECUTION_ENABLED=0
# off = 只写 MySQL，不投递队列
AGENT_QUEUE_MODE=off
```

启动自检只在 `AGENT_ENABLED=1` 时要求任务表可连接，未迁移的环境仍可正常启动原有服务。

## 2. 数据库

执行迁移：

```bash
npm run migrate
```

新增表（`migrations/005_agent.sql`）：

| 表 | 作用 |
| --- | --- |
| `agent_tasks` | 任务主表，MySQL 是任务状态的唯一事实来源 |
| `agent_task_steps` | 模型 / 工具步骤记录，供轮询展示进度 |
| `agent_task_files` | 任务与现有 `app_files` 的授权/产物关联 |

所有用户侧查询都必须同时带 `user_id`，跨用户访问统一返回 404，避免任务 ID 被用于探测。

## 3. HTTP API

所有接口先经过现有 `authenticate`（HttpOnly Cookie / Bearer 回退），状态变更请求继续受全局 CSRF 中间件保护。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/agent/tasks` | 创建任务，返回 `202` + `task_id` |
| `GET` | `/api/agent/tasks/:taskId` | 查询任务、步骤摘要与文件列表 |
| `POST` | `/api/agent/tasks/:taskId/cancel` | 取消任务；终态任务返回 `cancelled=false` |
| `GET` | `/api/agent/tasks/:taskId/steps` | 查询步骤 |
| `GET` | `/api/agent/tasks/:taskId/files` | 查询任务文件 |
| `GET` | `/api/agent/tasks/:taskId/files/:fileId` | 查询单个文件元数据 |

创建请求体：

```json
{
  "message": "统计附件里的销售数据并生成汇总表",
  "conversation_id": "可选，必须是当前用户的会话",
  "file_ids": ["可选，必须是当前用户已上传的文件"]
}
```

幂等：请求头 `Idempotency-Key`（8–128 位字母/数字/`_`/`-`）。同一用户重复提交返回同一任务；不同用户互不影响。

## 4. 状态机

```
queued ──► running ──► waiting_model ──► running
   │          │              │
   ├──► failed / cancelled   ├──► completed / failed / cancelled / timed_out
   └──► cancelled            └──► ...
```

- 终态：`completed` / `failed` / `cancelled` / `timed_out`，不可回退。
- 条件迁移：`UPDATE ... WHERE status IN (...)`，并发取消/超时不会被 Worker 覆盖。
- 取消只改状态，不直接杀进程；Worker 在每步开始前读取状态并自行停止。
- 任务 600s 超时从 Worker 领取任务（`queued → running`）时开始计算，排队时间不计入。

## 5. 当前阶段边界

已实现：

- 任务 / 步骤 / 文件的内存与 MySQL 仓储；
- 创建、查询、取消服务与路由；
- 输入文件归属校验与授权快照；
- 状态机、工具 JSON Schema 校验、工具注册表、超时执行器；
- 任务工作目录管理器（路径穿越防护）；
- BullMQ 生产者 / Worker 工厂与独立 Worker 入口骨架；
- 全局并发默认 1、任务 600s、脚本 120s、文件/配额/保留期配置项。

尚未实现（后续阶段）：

- Anthropic Messages 模型循环与工具调用；
- Docker Python 执行器（禁网、只读根文件系统、资源上限）；
- 输出文件归档到现有 `app_files` / `blob-store`；
- 任务与日志的定时清理（保留期配置已就绪）；
- 前端 Agent 模式与 HTTP 轮询。

`AGENT_QUEUE_MODE=off` 时任务不会自动执行；但阶段 1 已加超时兜底（`core/task-watchdog.js`）：
没有消费方时任务约 10s 后落 `failed` + `AGENT_NO_CONSUMER`，排队超过 `AGENT_QUEUE_TIMEOUT_MS`
落 `timed_out` + `AGENT_QUEUE_TIMEOUT`，超过 `deadline_at` 落 `timed_out` + `AGENT_TASK_TIMEOUT`。
读任务（前端轮询）与 30s 巡检都会触发，因此前端不会再出现「提交后长时间无响应」。
`/health` 的 `agent.consumer` / `agent.has_consumer` 用于让前端提前判断有没有执行进程。

## 6. Worker

阶段 1 的 Worker 入口仅用于验证队列链路，默认拒绝启动：

```bash
npm run worker:agent
```

启动条件（全部满足）：`AGENT_ENABLED=1`、`AGENT_QUEUE_MODE=bullmq`、`AGENT_EXECUTION_ENABLED=1`、`REDIS_URL` 与 `MYSQL_URL` 均已配置。生产只启动一个 Worker 进程（`AGENT_WORKER_CONCURRENCY=1`），保证全局并发为 1。

生产环境用独立系统账号运行 Worker，只授予其 Agent 工作目录、MySQL/Redis 与上游 Key 的访问权限；不要把 `docker.sock` 暴露给 Worker，Docker 调用应由 root 控制的 launcher 代理（阶段 3 接入）。

## 7. 操作手册

- [阶段 1 上线执行单](agent-phase1-go-live.md)：本次构建包、备份、解包、迁移、配置、重启、验收、回滚的按序命令。
- [第 3 步：生产部署操作手册](agent-step3-deploy.md)：迁移执行、环境变量、Worker 账号/目录、systemd、Nginx/CSRF、回滚。
- [第 4 步：上线验收与灰度操作手册](agent-step4-acceptance.md)：curl/自动验收脚本、SQL 检查、灰度步骤、阶段 1 验收判定。

这两步都是运维操作，不需要修改业务代码。阶段 2/3 开启 Worker 与 Docker 执行器后，需按后续开发计划继续改代码，并补充 Worker 的 EnvironmentFile 与 launcher 配置。

## 8. 安全约束

- 模型与用户输入都不直接决定文件路径；所有文件名先 `basename` + 字符清洗，再校验目标仍在任务目录内。
- 工具参数在服务端按 JSON Schema 二次校验，未知字段/未知工具一律拒绝。
- 工具定义发给模型时只包含 `name` / `description` / `input_schema`，不暴露 handler。
- 脚本语言枚举当前只有 `python`；容器策略固定 `network=none`、只读根文件系统、非特权、内存/CPU/PID 上限。
- 任务 ID、文件 ID 只接受固定字符集，避免把任意字符串带入仓储或路径拼接。
