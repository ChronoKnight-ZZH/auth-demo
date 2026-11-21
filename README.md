# auth-demo

后端登录与凭证验证 Demo，按《后端登录与凭证验证实施方案》实现。

技术栈：**Node.js（20+/22 LTS）+ Express 5 + MySQL 8.4（可选）+ Redis 7.2（可选）**

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
{"ok":true,"backends":{"user":"mysql","session":"redis"},"userStoreVersion":"8.4.x"}
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

## 测试与验收

```bash
npm test                  # 单元测试（16 项）
npm run smoke             # 端到端冒烟（需服务已启动，16 项）
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

内存模式下可通过调试接口或直接改代码触发；MySQL 模式：

```sql
UPDATE users SET status='locked' WHERE username='alice';
```

随后用锁定前的有效 Token 调 `/auth/me`，应返回 `403 ACCOUNT_LOCKED`。

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
│   │   ├── user-repo.js        # 接口
│   │   ├── mysql-user-repo.js  # MySQL 实现
│   │   └── memory-user-repo.js # 内存实现
│   ├── session/
│   │   ├── token.js            # Token 生成与哈希
│   │   ├── store.js            # 接口（revokeAll = 版本失效）
│   │   ├── redis-store.js      # Redis 实现（Lua 原子写入）
│   │   └── memory-store.js     # 内存实现（A-U-03 第二实现）
│   ├── middleware/authenticate.js
│   ├── services/auth-service.js
│   ├── routes/auth.js
│   └── lib/                    # 错误、限流、.env 加载
├── migrations/001_init.sql
├── scripts/                    # 密钥、迁移、种子、冒烟、验证、构建
├── test/unit.test.js
├── deploy/                     # systemd、Nginx
├── docker-compose.yml
└── public/index.html
```

## 生产部署（CentOS Stream 9）

```bash
# 1) 依赖
dnf module install -y nodejs:22
dnf module install -y mysql:8.4
dnf module install -y redis:7.2
dnf install -y nginx certbot python3-certbot-nginx
dnf groupinstall -y "Development Tools" && dnf install -y python3   # argon2 可能需源码编译

# 2) 目录与用户
useradd -r -s /sbin/nologin authsvc
mkdir -p /opt/auth-demo /etc/auth-demo
chown -R authsvc:authsvc /opt/auth-demo

# 3) 密钥与 pepper（用 systemd LoadCredential 注入）
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /etc/auth-demo/rsa_private.pem
openssl pkey -in /etc/auth-demo/rsa_private.pem -pubout -out /etc/auth-demo/rsa_public.pem
openssl rand -base64 48 > /etc/auth-demo/pepper
chmod 600 /etc/auth-demo/rsa_private.pem /etc/auth-demo/pepper
chown root:authsvc /etc/auth-demo/*.pem /etc/auth-demo/pepper

# 4) 部署单元
cp deploy/auth-demo.service /etc/systemd/system/
cp deploy/nginx-auth-demo.conf /etc/nginx/conf.d/
setsebool -P httpd_can_network_connect 1        # SELinux：允许 Nginx 反代
firewall-cmd --permanent --add-service={http,https}
firewall-cmd --reload

# 5) 证书
certbot --nginx -d auth.example.com --agree-tos -m ops@example.com --redirect

# 6) 启动
systemctl daemon-reload
systemctl enable --now auth-demo nginx mysqld redis
systemctl status auth-demo
```

### 关键运维配置（勿遗漏）

Redis（`/etc/redis/redis.conf`）：

```
bind 127.0.0.1
requirepass <强随机值>
maxmemory 256mb
maxmemory-policy noeviction     # 会话是数据不是缓存
appendonly yes
```

MySQL（`/etc/my.cnf.d/auth.cnf`）：

```
[mysqld]
bind-address=127.0.0.1
innodb_buffer_pool_size=512M
performance_schema=OFF
```

备份：

```bash
mysqldump --single-transaction --routines --triggers auth_demo \
  | gzip > /var/backups/auth-$(date +%F).sql.gz
# 必须同步到机外
```

## 安全注意事项

1. **Redis 中的 `sha256(token)` 是直接能力凭据**，不是加盐哈希 —— 拿到 Redis 内容即可冒充用户。Redis 必须只监听回环并启用密码（验收 A-D-02）。
2. `.env` 与 `secrets/` **不可提交版本控制**；生产用 systemd `LoadCredential=` 注入。
3. **RSA 字段加密不能替代 TLS**，必须由 Nginx 终结并强制 HTTP→HTTPS。
4. 本 Demo 未实现「记住我」/ Refresh Token（方案 §10 Q-09 已确认不做）；会话最长 7 天。
5. 「不保证 Redis 故障期间会话存活」（方案 N-07）：Redis 重启且未开 AOF 时版本键可能丢失，此时旧会话按「放行并告警」处理。

## 已知限制

- Argon2 档位为 `m=19456,t=2,p=1`，低于 OWASP 首选档，是为 2C4G 单机做的**显式取舍**（方案 N-08）；PHC 留痕，扩容后自动 rehash 升级。
- 单机单实例，无 Sentinel/Cluster。
- 本机实测环境为 Windows + Node 20；**目标环境 CentOS Stream 9 + Node 22 的构建与压测未执行**。