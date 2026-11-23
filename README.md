# auth-demo

后端登录与凭证验证 Demo，按《后端登录与凭证验证实施方案》实现。

技术栈：**Node.js（16.17+ / 18 / 20 / 22）+ Express 5 + MySQL 8.4（可选）+ Redis 7.2（可选）**

## 三条核心安全约束的落地

| 约束 | 实现 | 代码位置 |
| --- | --- | --- |
| 前端 RSA 加密传输 | **RSA-OAEP + SHA-256**，明文上限 **190 字节**；前端 WebCrypto `RSA-OAEP`，加密前校验上限 | `src/crypto/rsa.js`、`public/index.html` |
| 密码加盐哈希 | **Argon2id + 每用户随机盐 + pepper**；PHC 字符串持久化；rehash-on-login | `src/crypto/password.js` |
| Opaque Token + 服务端会话 | 32 字节随机 Token，存储只存 `sha256(token)`；会话状态在 Redis/内存 | `src/session/` |

### 与方案定稿一致的关键设计

- **解密失败折叠**：不返回 `DECRYPT_FAILED`，统一折叠为 `401 INVALID_CREDENTIALS`，消除 padding oracle 可区分面。
- **版本化撤销**：改密递增 `credential_version` 并写穿 `credver:{userId}`，旧会话在中间件比对时失效 —— **O(1)，无 SCAN**。
- **锁定生效**：`status` 写入会话并在中间件校验，锁定对已签发 Token 立即生效。
- **存储故障语义**：会话存储不可用返回 **503**，绝不返回 401。
- **计数闸前置**：失败计数在 `argon2.verify` **之前**检查，避免并发穿透。
- **Argon2 并发闸**：`MAX_CONCURRENT_HASH=2` + 有界队列，满载 429；dummy verify 同闸。
- **长度前缀协议**：`v1\n<len>\n<username><password>`，用户名含 `||`/中文/换行均无歧义。

## 快速开始（零依赖，内存模式）

无需 MySQL / Redis，开箱即跑：

```bash
npm install --ignore-scripts   # argon2 使用预编译二进制，无需编译
cp .env.example .env
node scripts/gen-keys.js       # 生成 RSA-2048 密钥对
npm start
```

打开 <http://127.0.0.1:3000> 即可登录。种子账号：

| 账号 | 密码 |
| --- | --- |
| `alice` | `Alice@Passw0rd` |
| `bob` | `Bob@Passw0rd` |

> `--ignore-scripts` 说明：`argon2` 的安装脚本是 `node-gyp-build`（无预编译产物时才编译）。若不希望跳过，可先 `npm install -g node-gyp` 并确保有 C++ 工具链。**上线前必须在目标机用不带 `--ignore-scripts` 的 `npm ci` 验证一次**（方案 A-B-01）。

## 本地 MySQL + Redis

本机联调使用：

```env
MYSQL_URL=mysql://deepseek:<password>@127.0.0.1:3306/deepseek
REDIS_URL=redis://127.0.0.1:6379/0
```

初始化并写入种子用户：

```bash
node scripts/migrate.js
node scripts/seed.js --mysql
npm start
```

`/health` 应显示 `user=mysql`、`session=redis`、`chat=mysql`、`files=mysql+disk`。

## 构建产物（dist）

服务是纯 CommonJS，不需要编译；`build` 做的是**运行时打包**：

```bash
npm run build        # 生成 dist/
npm run start:dist   # 用仓库根目录的 .env / secrets 启动产物（本地验证）
```

产物包含：

```
dist/
├── src/                 # 服务代码
├── public/index.html    # 登录 Demo 页
├── migrations/          # MySQL 迁移
├── scripts/             # 迁移、种子、冒烟脚本
├── deploy/              # systemd / Nginx 示例
├── .env.example
├── DEPLOY.md
├── package.json
└── package-lock.json
```

**不会**包含 `.env`、`secrets/`、`node_modules/`、`test/`。构建脚本会主动检查，
发现机密文件出现在产物中会直接失败。

部署到目标机：

```bash
npm run build
rsync -a --delete dist/ /opt/auth-demo/
cd /opt/auth-demo
npm ci --omit=dev
# 按部署环境提供 .env、/etc/auth-demo 下的 RSA 密钥与 pepper
node src/server.js
```

`npm run start:dist` 只是本地验证入口，会复用仓库根的 `node_modules`；
生产环境必须先在 `dist/` 中执行 `npm ci --omit=dev`。

> 不使用 esbuild/webpack 打包：`argon2` 是原生模块，单文件 bundle 后仍需
> `node_modules` 中的 `.node` 二进制；`mysql2`、`ioredis` 也存在动态加载路径，
> 直接复制运行文件更可靠。若后续要容器化，可在 `dist/` 之上加 Dockerfile。

## 容器化运行（生产）

`docker-compose.yml` 编排的是 **MySQL 8.4 + Redis 7.2**。应用本身在服务器上以容器运行
（镜像由 `dist/` 产物 + `argon2` 原生模块构建）。容器内需保证：

| 变量 | 容器取值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 默认 `127.0.0.1` 只监听回环，同容器网络里的 Nginx / 端口映射进不去 |
| `MYSQL_URL` | `mysql://authdemo:authdemo_pw@mysql:3306/auth_demo` | 用 compose 服务名，而不是 `127.0.0.1` |
| `REDIS_URL` | `redis://:authdemo_redis_pw@redis:6379/0` | 同上 |
| `PEPPER` / `RSA_*_PATH` | Secret 挂载 | 不落镜像层；见 `auth-demo.service` 的 `LoadCredential` |
| `FILES_DIR` | `/data/files`（挂 volume） | 默认写仓库内 `data/files`，容器重建即丢原件 |
| `CORS_ORIGINS` | 见下 | 仅前后端分域时需要 |

### 跨域（CORS）

后端鉴权用 **Opaque Bearer Token，不使用 Cookie**，因此没有 SameSite 跨站问题。是否下发
CORS 头由 `CORS_ORIGINS` 单一开关决定（`src/middleware/cors.js`）：

- **同源反代**（前端 Nginx 把 `/auth`、`/v1` 转发到本站）：`CORS_ORIGINS` 留空，中间件
  完全直通，行为与加它之前逐字节一致。这是 `deploy/nginx-auth-demo.conf` 的设计。
- **分域直连**（前端 `chat.shunkai-dg.cn` 直接请求 `api.shunkai-dg.cn`）：必须设
  `CORS_ORIGINS=https://chat.shunkai-dg.cn`（逗号分隔多个来源）。命中白名单时回显具体来源
  `Access-Control-Allow-Origin` + `Allow-Credentials: true`，放行预检头 `Authorization`、
  `Content-Type`、`Accept`、`X-Request-Id`、`X-File-Name`、`X-File-Mime`；非白名单来源预检
  返回 403。`*` 会反射任意来源（无 Cookie 故无 CSRF 会话风险，但生产建议显式列白名单）。

> `chat-demo` 前端生产默认就是**分域直连** `api.shunkai-dg.cn`（`credentials: include`），
> 所以线上后端记得配 `CORS_ORIGINS`，否则登录/聊天/上传会被浏览器全部拦截。
> 若改用同源反代，则把前端按 `BFF_BASE=/v1`、`AUTH_BASE=/auth` 重新构建，后端留空。

## 切换到 MySQL 8.4 + Redis

```bash
docker compose up -d           # 启动 MySQL 8.4 + Redis 7.2（含 noeviction / AOF）

# .env 中填入：
MYSQL_URL=mysql://authdemo:authdemo_pw@127.0.0.1:3306/auth_demo
REDIS_URL=redis://:authdemo_redis_pw@127.0.0.1:6379/0

npm run migrate                # 建库建表
npm run seed                   # 写入种子用户
npm start
```

`/health` 会显示当前使用的后端：

```json
{"ok":true,"backends":{"user":"mysql","session":"redis","chat":"mysql","files":"mysql+disk","stream":"redis"},"userStoreVersion":"8.4.x"}
```

## 接口

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/health` | 否 | 健康检查，显示存储后端与版本 |
| `GET` | `/auth/public-key` | 否 | 返回 PEM 公钥 + `oaepHash` + `maxPlaintextBytes` |
| `POST` | `/auth/login` | 否 | 接收 `{ encrypted }`，返回 `{ token, expiresAt }` |
| `POST` | `/auth/logout` | Bearer | 删除当前会话（幂等） |
| `GET` | `/auth/me` | Bearer | 凭证验证，返回 `{ userId }` |
| `POST` | `/auth/change-password` | Bearer | 校验旧密码 → 更新哈希 → 撤销全部会话 |

BFF（浏览器不再持有上游 Key）：

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/v1/chat/stream` | Bearer | 流式聊天；支持 `X-Request-Id` 与 `Last-Event-ID` 续推 |
| `GET` | `/v1/chat/stream` | Bearer | 只读续推：`?requestId=&cursor=` |
| `POST` | `/v1/chat/stop` | Bearer | 停止自己的流；返回 `{ ok, stopped }` |
| `GET` | `/v1/models` | Bearer | 上游连通性探测 |
| `POST` | `/v1/files` | Bearer | 附件 multipart 透传到上游 Files API |
| `DELETE` | `/v1/files/:fileId` | Bearer | 删除上游文件 |
| `POST` | `/v1/tools/asr` | Bearer | 语音识别代理（≤8MB） |
| `POST` | `/v1/tools/tts` | Bearer | 语音合成代理，返回音频流 |
| `POST` | `/v1/files/originals` | Bearer | **服务端原件归档**：请求体即文件字节，文件名/MIME 放 `X-File-Name` / `X-File-Mime` |
| `GET` | `/v1/files/originals/:id/url` | Bearer | 按 `?sessionId=` 签发短期 `p`（内联）/ `r`（下载）/ `t` 票据 |
| `DELETE` | `/v1/files/originals/:id` | Bearer | 软删除原件元数据（物理块留给后续 GC） |
| `GET` | `/v1/files/content` | 票据 | 凭 `?file_id=&state=&ty=` 读取原件；支持 Range / ETag |
| `GET` | `/v1/sessions` | Bearer | 会话列表；`?full=1` 返回全部消息（搜索/导出用） |
| `GET` | `/v1/sessions/:id` | Bearer | 读取单个会话 |
| `POST` | `/v1/sessions` | Bearer | 新建会话（前端通常直接用 PUT upsert） |
| `PUT` | `/v1/sessions/:id` | Bearer | 整条会话 upsert（消息 JSON） |
| `PATCH` | `/v1/sessions/:id` | Bearer | 重命名 |
| `DELETE` | `/v1/sessions/:id` | Bearer | 软删除单个会话 |
| `DELETE` | `/v1/sessions` | Bearer | 清空当前用户全部会话 |

### 载荷格式

登录（`v1`）：

```
"v1\n" + byteLength(username) + "\n" + username + password
```

改密（`v2`）：

```
"v2\n" + ulen + "\n" + username + olen + "\n" + oldPassword + newPassword
```

两者都用长度前缀，**不要**用 `||` 等分隔符拼接。

## 附件原件存储（里程碑 3）

浏览器 IndexedDB 只是缓存；**服务端保存原件**，换设备/清缓存后仍能显示和下载。

- **内容寻址**：`<FILES_DIR>/blobs/<sha256[0:2]>/<sha256>`，上传时边收边算 sha256，
  先写 `tmp/` 再 `fsync` + `rename` 原子落盘；同内容自动去重（`DEDUPE_SCOPE=global`
  跨用户复用，`user` 只在用户内复用）。
- **元数据**：`app_files`（归属、sha256、storage_key、size、mime、name、is_image、软删除）+
  `app_file_refs`（文件 → 会话引用）。`PUT /v1/sessions/:id` 时从消息 JSON 的
  `files[].storageId` 重建引用；引用同步失败只告警，不阻塞会话保存。
- **票据而非 Bearer**：`<img src>` 无法携带 `Authorization`。`GET /v1/files/originals/:id/url`
  按会话签发 HMAC 票据（默认 30 min），`GET /v1/files/content` 只验票据，并回查
  **文件归属 + 会话存活**；跨用户与不存在统一 404，篡改/过期统一 403。
- **票据不入库**：不写进会话 JSON，前端只缓存到过期前；图片加载失败时重签一次。
- **安全响应头**：`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、
  非图片一律 `attachment` + `application/octet-stream`；MIME 以文件头嗅探为准，
  伪装成 `image/svg+xml` 等会被降级为二进制，避免 XSS。
- **限制**：单文件默认 64 MiB（`FILES_MAX_BYTES`），与前端 `MAX_SIZE_MB` 对齐；
  存储键只由服务端生成，拒绝任何含路径分隔符的输入。

```env
FILES_MODE=local                 # off = 关闭服务端原件，前端退回纯 IndexedDB
FILES_DIR=/data/deepseek/files   # 生产挂载独立磁盘
FILES_MAX_BYTES=67108864
FILE_TOKEN_SECRET=<强随机值>      # 未设置时用 PEPPER 派生，仅限本地开发
FILE_TOKEN_TTL_MS=1800000
DEDUPE_SCOPE=global              # global | user
```

> 缩略图生成、病毒扫描、物理块 GC 均未实现：软删除只影响元数据，已上传的 blob
> 需后续离线清理任务回收。文件预览当前只支持图片（浏览器内弹窗），文档只提供下载。

## 账号管理（CLI）

不开放注册，账号只能由管理员在服务器上创建。需要 `MYSQL_URL`；锁定和重置密码
会递增凭证版本并写穿 Redis，使该用户全部旧 Token 立即失效。

```bash
npm run user:list
npm run user:create -- --username alice          # 交互输入密码（推荐）
npm run user:create -- --username alice --password 'Passw0rd!'   # 自动化/脚本
npm run user:lock -- --username alice
npm run user:unlock -- --username alice
npm run user:reset-password -- --username alice  # 交互输入新密码
```

规则：用户名最多 64 字符；密码至少 8 个字符；用户名与密码的 UTF-8 总长度不超过
180 字节（登录 RSA-OAEP 明文上限 190 字节）。`--password` 会进入 shell 历史，
生产建议交互输入或从受控脚本注入。

## 历史导入（CLI）

浏览器端不提供导入，只能由管理员在服务器上导入 chat-demo 导出的
`deepseek_data-*.zip`（`export_format_version = 3`）：

```bash
npm run import:history -- --user alice --file /data/backup/deepseek_data-2026-11-22.zip
npm run import:history -- --user alice --file backup.zip --dry-run
npm run import:history -- --user alice --file backup.zip --replace
```

- `--dry-run`：完整校验 ZIP、消息树、图片路径与大小，只输出统计，不写库/磁盘。
- 默认**跳过已存在的会话 id**，重复导入同一 ZIP 不会产生重复会话；`--replace`
  会先物理删除同 id 会话再写入（不跨会话事务，失败时已替换的旧内容无法恢复）。
- 图片按会话目录写入服务端原件存储，并直接写入 `files[].storageId`；其他附件
  归档里只有元数据，导入后仍只显示文件卡片。
- 导入的图片首次进入新请求时，前端会从 BFF 取回原件再上传上游 Files API，
  不需要浏览器重新选择文件。
- 每次正式导入写入 `import_jobs`：执行者（OS 账号）、来源文件名、ZIP sha256、
  会话/图片统计、成功/失败原因；`--dry-run` 不写审计。失败在预校验阶段不会写入任何会话。
- 导入直接写库，不会通知在线页面；建议在用户离线时执行，`--replace` 尤其要避免与
  用户编辑同一会话并发。
- 限制：ZIP ≤ 256 MiB、解压总量默认 512 MiB（`--max-mb` 可调）、单条会话 JSON
  ≤ 8 MiB；不支持 ZIP64、加密 ZIP 与符号链接。

## 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_CREDENTIALS` | 401 | 账号或密码错误（也用于解密失败，不可区分） |
| `INVALID_INPUT` | 400 | 输入格式/长度不合法 |
| `TOKEN_MISSING` | 401 | 缺少 `Authorization: Bearer` |
| `TOKEN_INVALID` | 401 | Token 无效或已因改密失效 |
| `TOKEN_EXPIRED` | 401 | 超过绝对寿命 |
| `ACCOUNT_LOCKED` | 403 | 账号被锁定 |
| `TOO_MANY_ATTEMPTS` | 429 | 失败次数达阈值 |
| `AUTH_BUSY` | 429 | Argon2 并发闸满 |
| `SESSION_WRITE_FAILED` | 503 | 会话写入失败 |
| `SESSION_STORE_UNAVAILABLE` | 503 | 会话存储不可用（非凭证问题） |
| `UPSTREAM_NOT_CONFIGURED` | 503 | 服务端未配置上游 Key |
| `UPSTREAM_UNAVAILABLE` | 503 | 熔断打开 |
| `UPSTREAM_REJECTED` | 502 | 上游拒绝请求（含上游 401/403） |
| `UPSTREAM_ERROR` | 502 | 上游 5xx / 网络错误 |
| `UPSTREAM_TIMEOUT` | 504 | 上游超时 |
| `UPSTREAM_RATE_LIMITED` | 429 | 上游限流 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超过路由上限 |
| `FILE_TOKEN_INVALID` | 403 | 文件票据非法、被篡改或已过期 |
| `FILE_ACCESS_DENIED` | 404 | 文件/会话不属于当前用户或已删除（与不存在统一） |
| `FILES_DISABLED` | 503 | `FILES_MODE=off`，服务端未启用原件能力 |

## 本地测试上游

后台默认连远程 API（`UPSTREAM_BASE_URL=https://api.deepseek.com`）。要离线跑通中转链路，仓库提供两个本地假上游，都只需改 `.env` 里的 `UPSTREAM_BASE_URL` / `UPSTREAM_API_KEY`，业务代码零改动：

| 脚本 | 端口 | 用途 |
| --- | --- | --- |
| `npm run mock:upstream` | 8787 | 吐固定 `tok0 tok1 …`，配合 `npm run smoke:stream` 验证链路机制 |
| `npm run mock:echo` | 8788 | **复读机**：原样复读你发的内容，验证「转发保真度」 |

### 复读机（echo-upstream）

```bash
npm run mock:echo
# .env
#   UPSTREAM_BASE_URL=http://127.0.0.1:8788
#   UPSTREAM_API_KEY=sk-echo-any-non-empty-value
npm start
```

- 浏览器打开 <http://127.0.0.1:8788> = 自带极简测试台，绕开登录直接打 `/v1/chat/completions`，可单独确认复读机本身工作。
- 端点覆盖后台用到的全部上游路径：`/anthropic/v1/messages`（Anthropic 流式 + 非流式）、`/v1/chat/completions`（OpenAI 流式 + 非流式）、`/models`、`/anthropic/v1/files`、`/v1/tools/asr`、`/v1/tools/tts`。
- 复读正文会附一行元信息（`model` / `stream` / `user轮次` / `system 字数` / `非文本块`），**附件是否真送到上游一眼可见**；`GET /__calls` 看上游收到的完整请求，`POST /__reset` 清空。
- 在聊天框正文首行打命令即可注入故障，不必改代码或配置（也支持 `?fail=500` query 与 `metadata.mock`）：

  | 命令 | 效果 |
  | --- | --- |
  | `/fail 500` / `429` / `400` / `network` / `idle` / `errorframe` | 上游异常：真实状态码 / 掐 socket / 发一帧后永久静默 |
  | `/delay 3s` | 首字节延迟（测 headers 超时与前端 loading） |
  | `/gap 300` | 每个增量间隔 300ms（测心跳、慢流） |
  | `/stopat 5` | 只发 5 块就断，不发 `message_stop`（测断点续推） |
  | `/tokens 40` | 强制切成 40 块 |
  | `/repeat 3` | 复读 3 遍（测长回复、缓冲截断） |
  | `/mode upper\|reverse\|count` | 大写 / 倒序 / 只报字数 |
  | `/stop max_tokens` | 指定 `stop_reason` |

```bash
npm run test:echo      # 复读机自身 12 项单测（零依赖）
npm run smoke:echo     # 复读机 × 中转链路 端到端 19 项（自起服务，不需 MySQL/Redis/远程 Key）
```

## 测试与验收

```bash
npm test                  # 单元测试（25 项）
npm run test:echo         # 本地复读机上游单测（12 项，零依赖）
npm run smoke             # 端到端冒烟（需服务已启动，16 项）
npm run smoke:stream      # 中转链路端到端（自起 mock 上游）
npm run smoke:echo        # 中转链路端到端（自起复读机上游，零远程依赖）
npm run verify:gate       # 闸门/时序/不可区分性验证（需服务已启动）
npm run verify:webcrypto  # 前端 WebCrypto 互通性验证
npm run verify:all        # 串行执行以上全部
```

### 验收项覆盖

| 验收项 | 覆盖方式 | 状态 |
| --- | --- | --- |
| A-F-01 正确登录返回 Token | `smoke.js` | ✅ 实测通过 |
| A-F-02 `/auth/me` 返回 userId | `smoke.js` | ✅ 实测通过 |
| A-F-04 存储中只存哈希 | `unit.test.js` | ✅ 实测通过 |
| A-F-07 拼接协议边界 | `unit.test.js` | ✅ 实测通过 |
| A-E-01 非法密文折叠 | `smoke.js`、`verify-gate.js` | ✅ 实测通过 |
| A-E-02 错误响应一致 | `smoke.js`、`verify-gate.js` | ✅ 实测通过（逐字节比对） |
| A-E-03 Token 缺失/无效 | `smoke.js` | ✅ 实测通过 |
| A-E-04 连续失败 429 | `smoke.js`、`verify-gate.js` | ✅ 实测通过 |
| A-E-05 登出失效 | `smoke.js` | ✅ 实测通过 |
| A-E-06 改密撤销全部会话 | `smoke.js`、`unit.test.js` | ✅ 实测通过 |
| A-E-07 绝对过期 | `unit.test.js` | ✅ 实测通过（应用层判定） |
| A-S-01 padding/摘要同源 | `unit.test.js`（sha1 必须失败） | ✅ 实测通过 |
| A-S-08 Argon2 闸门在前 | `verify-gate.js`（40 并发无 500） | ✅ 实测通过 |
| A-S-09 响应不可区分 | `verify-gate.js` | ✅ 实测通过 |
| A-U-02 OAEP 互通往返 | `verify-webcrypto.js` | ✅ 实测通过 |
| A-U-03 第二套存储实现 | `MemorySessionStore` vs `RedisSessionStore` | ✅ 接口等价 |
| A-F-03 库中只有 PHC | `npm run seed` 输出可查；需连库复核 | ⚠️ 需连库 |
| A-E-08 锁定生效 | 需 `setStatus` 触发，见下方说明 | ⚠️ 需连库/内存 |
| A-B-01 目标机构建 | **须在 CentOS Stream 9 实机执行** | ⚠️ 未执行 |
| A-D-01/02/03 TLS | 需部署 Nginx + Let's Encrypt | ⚠️ 未执行 |
| A-P-01/03 容量实测 | 需在 2C4G 目标机压测 | ⚠️ 未执行 |

> ⚠️ 标记项**未在本机执行**，不可视为已通过。特别是 A-P-01/03：本机（Windows，Node 20）实测 Argon2 verify ≈ **34 ms**（m=19456,t=2,p=1），仅作参考，**不能替代目标机数据**。

### 手动验证 A-E-08（锁定生效）

推荐直接用 CLI；它会递增凭证版本并写穿 Redis，立即撤销旧会话：

```bash
npm run user:lock -- --username alice
```

若只执行 SQL `UPDATE users SET status='locked'`，数据库中状态会更新，但已经签发的
会话仍保留登录时的状态快照；需要同时递增 `credential_version` 并写穿 Redis
（或让用户重新登录）才会立即生效。

随后用锁定前的有效 Token 调 `/auth/me`，应返回 `401 TOKEN_INVALID`（版本失效）；
锁定后重新登录则返回 `403 ACCOUNT_LOCKED`。

## 目录结构

```
auth-demo/
├── src/
│   ├── config.js               # 统一配置 + 自检
│   ├── app.js                  # 装配、启动自检、后端选择
│   ├── server.js               # 入口
│   ├── crypto/
│   │   ├── rsa.js              # OAEP 解密 + 载荷协议
│   │   └── password.js         # Argon2id + pepper + 并发闸
│   ├── db/
│   │   ├── user-repo.js        # 用户接口
│   │   ├── mysql-user-repo.js  # 用户 MySQL 实现
│   │   ├── memory-user-repo.js # 用户内存实现
│   │   ├── chat-repo.js        # 会话接口
│   │   ├── mysql-chat-repo.js  # 会话 MySQL 实现
│   │   ├── memory-chat-repo.js # 会话内存实现
│   │   ├── file-repo.js        # 原件元数据接口
│   │   ├── mysql-file-repo.js  # 原件 MySQL 实现
│   │   ├── memory-file-repo.js # 原件内存实现
│   │   └── audit-repo.js       # import_jobs 审计
│   ├── files/
│   │   ├── blob-store.js       # 内容寻址、原子落盘、Range
│   │   ├── mime.js             # 文件头嗅探与安全降级
│   │   └── token.js            # HMAC 访问票据
│   ├── import/
│   │   ├── zip-reader.js       # 只读 ZIP32（STORE/DEFLATE、CRC）
│   │   ├── history.js          # 归档校验与本地 Session 转换
│   │   └── import-history.js   # 导入事务、图片归档、幂等/回滚
│   ├── account/admin-service.js # 账号创建/锁定/解锁/重置密码
│   ├── session/
│   │   ├── token.js            # Token 生成与哈希
│   │   ├── store.js            # 接口（revokeAll = 版本失效）
│   │   ├── redis-store.js      # Redis 实现（Lua 原子写入）
│   │   └── memory-store.js     # 内存实现（A-U-03 第二实现）
│   ├── middleware/authenticate.js
│   ├── services/auth-service.js
│   ├── routes/auth.js          # 认证
│   ├── routes/sessions.js      # 会话持久化
│   ├── routes/file-storage.js  # 原件上传 / 票据 / 读取
│   ├── routes/chat.js          # 聊天流转发 + stop
│   ├── routes/proxy.js         # 文件 / TTS / ASR 代理
│   └── lib/                    # 错误、限流、.env 加载
├── migrations/
│   ├── 001_init.sql            # users
│   ├── 002_chat.sql            # chat_sessions
│   ├── 003_files.sql           # app_files / app_file_refs
│   └── 004_import.sql          # import_jobs 审计
├── data/files/                 # 本地原件目录（已 gitignore，生产另行挂载）
├── scripts/                    # 密钥、迁移、种子、admin、import、冒烟、验证、构建
├── test/unit.test.js + helpers # 单元测试与 ZIP 夹具
├── deploy/                     # systemd、Nginx
├── docker-compose.yml
└── public/index.html
```

## 生产部署

完整步骤、验收、备份恢复与回滚见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。当前推荐拓扑是分域直连：

```text
chat.shunkai-dg.cn  静态前端（chat-demo/dist）
api.shunkai-dg.cn   auth-demo → MySQL + Redis + /var/lib/auth-demo/files
```

生产配置文件：

| 文件 | 用途 |
| --- | --- |
| `deploy/env.production.example` | `/etc/auth-demo/env` 模板（CORS、MySQL、Redis、上游 Key、文件票据） |
| `deploy/auth-demo.service` | systemd 单元（systemd ≥244，LoadCredential/StateDirectory） |
| `deploy/auth-demo-centos7.service` | CentOS 7（systemd 219）兼容单元 |
| `deploy/nginx-api.conf` / `nginx-api-http.conf` | API 域名反代（正式 TLS / 首次签发 HTTP-only） |
| `deploy/mysql-auth.cnf` / `deploy/redis-auth.conf` | 2C4G 单机基线 |
| `deploy/auth-demo-backup.service` / `.timer` | 每日 MySQL + 附件备份 |
| `deploy/auth-demo-healthcheck.service` / `.timer` | 5 分钟健康检查 |
| `deploy/healthcheck.sh` / `deploy/verify-production.sh` | 健康检查与上线验收 |
| `chat-demo/deploy/nginx-chat.conf` / `nginx-chat-http.conf` | 前端静态站点（正式 TLS / 首次签发 HTTP-only） |

最短上线路径：

```bash
# 构建（本地/构建机）
cd auth-demo && npm ci && npm run build
cd chat-demo && npm ci && npm run build

# 服务器：解包 → npm ci --omit=dev → 填 /etc/auth-demo/env → 迁移 → systemd
# CentOS 7 用 deploy/auth-demo-centos7.service；Stream 9 用 deploy/auth-demo.service
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/migrate.js
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/admin.js create --username admin
systemctl enable --now auth-demo nginx mysqld redis

# 证书
certbot --nginx -d chat.shunkai-dg.cn -d api.shunkai-dg.cn \
  --agree-tos -m ops@example.com --redirect

# 备份与健康检查
systemctl enable --now auth-demo-backup.timer auth-demo-healthcheck.timer
```

> **CentOS 7(glibc 2.17)**：yum 只有 Node 16，可按下方「Node 16 兼容」直接运行；
> 但生产仍推荐用 unofficial-builds 的 `linux-x64-glibc-217` 构建安装 Node 20，并把 systemd 的
> `ExecStart` 改为 `/opt/node/bin/node`；步骤与校验见 [deploy/centos7-node20.md](deploy/centos7-node20.md)。

## Node 16 兼容

服务与验收脚本可在 **Node 16.17+** 运行（Node 16 已于 2023-09 EOL，仅用于无法升级的存量环境）：

- 全局 `fetch` 由 `undici@5` 补齐（`src/lib/fetch-global.js`，仅在缺失时加载）；Node 18+ 不加载，行为不变。
- `proxy.js` 的 Web Stream → Node Stream 桥接已兼容：Node 17+ 用 `Readable.fromWeb`，Node 16 走手写背压拉取。
- `/health` 的 `files.disk` 在 Node 16 为 `null`（`fs.statfs` 是 Node 18.15+），其余字段不变。
- 测试侧补齐了 Node 16 缺失的 `t.after`；`--test-timeout` 已从 npm 脚本移除。
- `express@5` 声明 `engines >=18`，在 Node 16 上实测可运行但不受官方支持；`npm install` 会给出引擎警告（未启用 `engine-strict`，不会失败）。

> 生产环境仍建议 Node 20 LTS。Node 16 的 TLS/HTTP 栈不再收到安全更新，用于登录系统需自行承担风险。

### 关键运维配置（勿遗漏）

- MySQL/Redis 只监听 `127.0.0.1`；Redis `maxmemory-policy noeviction` + AOF。
- `CORS_ORIGINS=https://chat.shunkai-dg.cn`；分域同站点时 `FILES_CORP=same-site`。
- `.env`/RSA 私钥/pepper 权限 600；上游 Key 只在服务器。
- 备份必须同时包含 MySQL 与 `/var/lib/auth-demo/files/blobs`，并复制到机外。
- 健康检查与 `verify-production.sh` 纳入上线验收。

## 安全注意事项

1. **Redis 中的 `sha256(token)` 是直接能力凭据**，不是加盐哈希 —— 拿到 Redis 内容即可冒充用户。Redis 必须只监听回环并启用密码（验收 A-D-02）。
2. `.env` 与 `secrets/` **不可提交版本控制**；生产用 systemd `LoadCredential=` 注入。
3. **RSA 字段加密不能替代 TLS**，必须由 Nginx 终结并强制 HTTP→HTTPS。
4. 本 Demo 未实现「记住我」/ Refresh Token（方案 §10 Q-09 已确认不做）；会话最长 7 天。
5. 「不保证 Redis 故障期间会话存活」（方案 N-07）：Redis 重启且未开 AOF 时版本键可能丢失，此时旧会话按「放行并告警」处理。
6. 文件票据是**能力 URL**：拿到链接的人在有效期内即可读取，因此不要把 `state` 写进日志、埋点或对外分享；示例 Nginx 已对 `/v1/files/content` 关闭 `access_log`。删除会话后票据立即失效。

## 已知限制

- Argon2 档位为 `m=19456,t=2,p=1`，低于 OWASP 首选档，是为 2C4G 单机做的**显式取舍**（方案 N-08）；PHC 留痕，扩容后自动 rehash 升级。
- 单机单实例，无 Sentinel/Cluster。
- 附件原件为**单机本地磁盘**：多实例部署前需换成共享存储；软删除不做物理 GC，也没有缩略图、病毒扫描与文档预览。
- 服务端只保存原件与元数据；浏览器 IndexedDB 仍是首屏显示与离线写入的缓存，删除会话不会删除已上传的原件元数据（仅解除引用）。
- 历史导入只归档 ZIP 内的图片；非图片附件在归档里本来只有元数据。导入过程不是跨会话事务：`--replace` 失败时已替换的会话无法恢复，极端情况下（DB 写入后崩溃）可能留下无元数据的 blob。
- ZIP 会整体读入内存，默认上限 256 MiB；更大的历史需要先拆分归档或后续改成流式读取。
- 本机实测环境为 Windows + Node 20；**目标环境 CentOS Stream 9 + Node 22 的构建与压测未执行**。