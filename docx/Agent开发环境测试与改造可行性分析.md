# Agent 功能开发环境测试与改造可行性分析

日期：2026-11-28 ｜ 环境：Windows / Node v20.20.1 ｜ 分支：main（8e4d36c）

## 一、背景

《服务器改造方案》（Agent Harness 执行器）确定分阶段实施：
阶段 1 任务基础设施、阶段 2 模型工具调用循环、阶段 3 Docker 脚本执行器、前端 Chat 轮询对接。
原则：不重构 Chat、不改 auth-demo 既有职责、独立新增 Agent 执行能力。

## 二、现状盘点（阶段 1 已落地）

| 组成 | 位置 | 状态 |
| --- | --- | --- |
| 任务表迁移 | `migrations/005_agent.sql`（tasks/steps/files，用户隔离+幂等键） | 完成 |
| API 路由 | `src/modules/agent/api/agent.routes.js` → `/api/agent/tasks` | 完成 |
| 功能闸 | `agent.feature-gate.js`（AGENT_ENABLED 总开关 + 白名单） | 完成 |
| 仓储 | memory / mysql 双实现，条件迁移防终态覆盖 | 完成 |
| 队列 | `agent-queue.js`：off / inline（仅开发）/ bullmq 三模式 | 完成 |
| 独立 Worker | `src/workers/agent.worker.js`（前置条件不满足拒绝启动） | 完成 |
| 执行循环 | `agent-loop.js`：领取任务→状态机→阶段 2/3 占位 | 占位 |
| 工具层 | tool-registry / tool-schema / tool-executor / workspace-manager | 骨架完成，handler 未注入 |
| 依赖 | bullmq、ioredis 已进 package.json | 完成 |

## 三、开发环境实测结果

### 1. 单元测试：`node --test test/agent.test.js` → **27/27 通过**（584ms）
覆盖：状态机迁移、参数校验、仓储用户隔离与幂等、创建/查询/取消服务、工具 schema/注册表/超时、工作目录防穿越、HTTP 全链路（202/401/403/404/503）。

### 2. 端到端冒烟：`npm run smoke:agent`（内存后端 + inline 队列 + 执行器开启）→ **12/12 通过**
真实启动 `src/server.js`（ENV_FILE=`data/agent-smoke-config`，端口 3100）验证：
- 健康检查暴露 Agent 状态 `{enabled, queueMode:inline, executionEnabled}`
- RSA-OAEP 登录（Cookie 会话）后创建任务 202 queued
- 未登录 401、空消息 400、未知任务 404 `AGENT_TASK_NOT_FOUND`
- 幂等键重复提交返回同一 task_id
- **全链路状态机闭环**：inline 队列即时领取（queued→running），阶段 1 占位执行器落为
  `failed + AGENT_EXECUTOR_UNAVAILABLE`，正是方案预期的端到端验证路径
- 取消接口对已终态任务正确返回 `cancelled:false`
- Worker 进程守卫验证：`queueMode=inline` 与缺 `REDIS_URL` 时均拒绝启动（exit=1），符合“Worker 只在 bullmq 模式运行”的设计。

### 3. 未覆盖项（本机条件限制）
- **MySQL 仓储 + BullMQ 真实队列**：本机未装 Docker（`docker-compose.yml` 的 MySQL 8.4/Redis 7.2 无法拉起），该组合需在有 Docker 的联调机执行。
- **Docker 执行器（阶段 3）**：本机无 Docker，完全未验证。
- 仓库根 `.env` 内容读取被本机安全策略拦截，测试全程使用独立 ENV_FILE，不影响结论。

## 四、可行性结论

| 改造项 | 结论 | 依据与条件 |
| --- | --- | --- |
| 阶段 1 基础设施 | ✅ 可行，已完成 | 39 项测试全通过，零侵入现有 Chat/auth 链路（`/api/agent` 独立挂载，默认关闭灰度开启） |
| 阶段 2 模型循环 | ✅ 可行 | agent-loop 预留 TODO 与状态 `waiting_model`；复用现有 upstream 客户端（三重超时、错误分类、熔断）；开发环境可用 `mock:upstream`/`mock:echo` 离线联调工具调用循环 |
| 阶段 3 Docker 执行 | ⚠️ 可行但有硬前提 | 执行机必须安装 Docker；`workspace-manager`/`execution-policy` 骨架已在。资源预算需复核：方案按 2C4G，容器限 768M/1CPU/128PID，与宿主 MySQL+Redis+Node 叠加偏紧，建议执行容器与主服务分机或加限额巡检 |
| bullmq 生产队列 | ✅ 可行 | 依赖已就绪，投递超时 3s 不拖住 API；需在联调机跑一次 MySQL+Redis 组合验证 |
| Chat 前端轮询 | ✅ 可行 | 响应体 `status_url/progress/files` 契约已定，snake_case 稳定 |

### 主要风险点
1. **Node 版本口径**：`package.json engines>=16.17`，但 Express 5 与 bullmq 实测要求 Node≥18；方案文档已指出，建议 engines 收紧为 `>=18`，部署按 `deploy/centos7-node20.md` 的 glibc-217 Node 20 走。
2. **迁移器无版本表**：`scripts/migrate.js` 每次全量重放，005 靠 `IF NOT EXISTS` 幂等可用，但后续加列需改成版本化迁移，否则重复执行会报错。
3. **CentOS 7 生产机 + Docker**：内核 3.10 对 overlay2/cgroup v1 支持老旧，阶段 3 上生产前必须在目标机验证 `agent-python:1` 镜像与容器限额；systemd 单元 `ProtectSystem=strict` 与挂载 docker.sock 的权限边界需要单独评审。
4. **inline 模式仅限开发**：生产误配 `AGENT_QUEUE_MODE=inline` 会让 API 进程直接执行任务；建议 validateConfig 在 `NODE_ENV=production` 时禁止 inline。
5. 阶段 2 预算控制（maxModelCalls=12 / maxToolCalls=20）与 600s 任务时限已有配置，但循环内扣减逻辑尚未接入，实现时需以 DB 计数为准，防 Worker 重启超发。

### 下一步建议（顺序）
1. 在有 Docker 的联调机：`docker compose up -d` → migrate 005 → MySQL 仓储 + bullmq 端到端跑通（可用同一冒烟脚本，baseUrl 不变）。
2. 阶段 2：接入 Anthropic Messages 工具循环（mock 上游先行），补 `waiting_model` 状态与预算扣减测试。
3. 阶段 3：构建 `agent-python:1` 受限镜像，先在本机 WSL2/远程 Linux 验证执行器，再评估 CentOS 7 承载。
4. 收紧 engines 与 inline 生产禁用；迁移器加版本表。

## 五、本次新增文件
- `scripts/smoke-agent.js`（`npm run smoke:agent`）：Agent 端到端冒烟脚本
- `data/agent-smoke-config`：开发冒烟专用 ENV_FILE（不触碰仓库 .env）
- `package.json`：注册 `smoke:agent`
