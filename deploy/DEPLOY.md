# 云端上线 Runbook（里程碑 5）

目标拓扑（当前前端构建默认就是分域直连）：

```text
浏览器
  ├─ https://chat.shunkai-dg.cn      静态前端（Nginx，/srv/chat-demo/dist）
  └─ https://api.shunkai-dg.cn       auth-demo Node（127.0.0.1:3000）
         ├─ MySQL 5.7/8.x            127.0.0.1:3306
         ├─ Redis 6/7                127.0.0.1:6379（noeviction + AOF）
         └─ /var/lib/auth-demo/files 附件原件（C A S）
```

单机 2C4G / 1–10 用户基线；正式上线前必须用真实流量压测确认。

> 当前 `chat.shunkai-dg.cn`、`api.shunkai-dg.cn` 的 A 记录指向 `192.168.1.188`，
> 这是内网地址，公网访问前需要改成云服务器公网 IP，并完成 ICP 备案。

---

## 0. 上线前确认

| 项目 | 要求 |
| --- | --- |
| 系统 | **CentOS 7（当前选择，systemd 219）**；Rocky/Alma/CentOS Stream 9 见文末备注 |
| Node | CentOS 7 用 unofficial-builds `linux-x64-glibc-217` Node 20，见 `centos7-node20.md` |
| MySQL | 5.7.38 已验证；8.0/MariaDB 10.6 兼容 |
| Redis | 6/7（Remi），必须 `appendonly yes`、`maxmemory-policy noeviction` |
| DNS | `chat`、`api` 两个 A 记录指向服务器 |
| 备案 | 境内服务器需先完成 ICP 备案，否则 80/443 会被拦截 |
| 证书 | 公网域名用 Let's Encrypt；纯内网可用内部 CA，验收时 `SKIP_TLS=1` |
| 上游 | DeepSeek API Key 只在服务器 env，绝不下发浏览器 |

安全基线：

- 只开放 22（限制来源）、80、443；MySQL/Redis 只监听 `127.0.0.1`。
- `.env` 600；RSA 私钥/pepper 640，属主 `root:authsvc`（CentOS 7 无 LoadCredential，服务用户需读）。
- `FILES_DIR` 独立目录/数据盘，不要和系统盘混用。
- 禁止把 `FILE_TOKEN_SECRET`、`UPSTREAM_API_KEY` 写进日志或前端。

---

## 1. 服务器初始化（CentOS 7）

```bash
# 以 root 执行
yum install -y curl tar gzip openssl epel-release policycoreutils-python
yum install -y nginx firewalld
yum install -y certbot python2-certbot-nginx   # 或从 EPEL 安装 certbot

# Node 20（glibc 2.17 专用构建）
# 严格按 deploy/centos7-node20.md 下载、校验 SHA256、解压到 /opt/node
/opt/node/bin/node -v
/opt/node/bin/node -e "console.log(typeof fetch, typeof require('stream').Readable.fromWeb)"

useradd -r -s /sbin/nologin authsvc
mkdir -p /opt/auth-demo /srv/chat-demo/dist /etc/auth-demo /var/backups/auth-demo
mkdir -p /var/lib/auth-demo/files
chown -R authsvc:authsvc /opt/auth-demo /srv/chat-demo /var/lib/auth-demo /var/backups/auth-demo
chmod 750 /var/backups/auth-demo
chmod 750 /var/lib/auth-demo
```

> CentOS 7 的 systemd 219 不支持 `LoadCredential=` / `StateDirectory=` / `MemoryMax=`，
> 因此使用 `deploy/auth-demo-centos7.service`，密钥通过 `/etc/auth-demo` 的 640 文件读取，
> 内存上限用 cgroup v1 的 `MemoryLimit=`。

### MySQL 5.7 / 8.0 / MariaDB

安装 MySQL（CentOS 7 可用官方 5.7/8.0 仓库或 MariaDB 10.6），把
`deploy/mysql-auth.cnf` 写入 `/etc/my.cnf.d/auth.cnf`，然后：

```bash
mkdir -p /var/log/mysql && chown mysql:mysql /var/log/mysql
systemctl enable --now mysqld
mysql -uroot -p
```

```sql
CREATE DATABASE auth_demo DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'authdemo'@'127.0.0.1' IDENTIFIED BY '替换为强随机密码';
GRANT ALL PRIVILEGES ON auth_demo.* TO 'authdemo'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### Redis

CentOS 7 基础源 Redis 版本较旧，建议用 Remi 安装 Redis 6/7。把
`deploy/redis-auth.conf` 合并进 `/etc/redis/redis.conf`（或 include），替换
`requirepass`，然后：

```bash
systemctl enable --now redis
redis-cli -a '密码' ping     # PONG
```

> 不要用 `yum install redis` 的 3.2 版本上生产；`ioredis` 能连，但缺少新版本修复。

---

## 2. 部署后端

### 2.1 本地/构建机构建

```bash
cd auth-demo
npm ci
npm run build
tar -czf auth-demo-dist-$(date +%F).tar.gz -C dist .
```

把 tar 包传到服务器（示例）：

```bash
scp auth-demo-dist-$(date +%F).tar.gz root@SERVER:/tmp/
```

### 2.2 服务器落盘

```bash
# 保留上一版，便于回滚
rm -rf /opt/auth-demo.prev
cp -a /opt/auth-demo /opt/auth-demo.prev 2>/dev/null || true
mkdir -p /opt/auth-demo
tar -xzf /tmp/auth-demo-dist-*.tar.gz -C /opt/auth-demo
cd /opt/auth-demo
/opt/node/bin/npm ci --omit=dev
chmod +x deploy/*.sh
```

> `npm ci` 会安装 argon2 原生模块；若目标机没有预编译产物，需要 gcc/make/python3。
> 不要把 `node_modules` 打进 tar 包（跨平台/glibc 不兼容）。

### 2.3 密钥与配置

```bash
cd /etc/auth-demo
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out rsa_private.pem
openssl pkey -in rsa_private.pem -pubout -out rsa_public.pem
openssl rand -base64 48 > pepper
openssl rand -base64 48 > file-token-secret

cp /opt/auth-demo/deploy/env.production.example env
chmod 600 env
chmod 640 rsa_private.pem rsa_public.pem pepper
chown root:authsvc env rsa_private.pem rsa_public.pem pepper
```

编辑 `/etc/auth-demo/env`，填入：

- `MYSQL_URL`、`REDIS_URL`（密码 URL 编码）
- `CORS_ORIGINS=https://chat.shunkai-dg.cn`
- `FILES_CORP=same-site`（前后端不同站点时改 `cross-origin`）
- `UPSTREAM_API_KEY`
- `FILE_TOKEN_SECRET=$(cat /etc/auth-demo/file-token-secret)`
- `FILES_DIR=/var/lib/auth-demo/files`

### 2.4 迁移与管理员账号

CLI 用 `ENV_FILE` 复用 systemd 的环境文件，避免复制第二份密钥：

```bash
cd /opt/auth-demo
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/migrate.js
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/admin.js create --username admin
ENV_FILE=/etc/auth-demo/env /opt/node/bin/node scripts/admin.js list
```

不要在生产执行 `npm run seed`（会写入演示账号并覆盖同名密码）。

### 2.5 systemd（CentOS 7）

```bash
cp /opt/auth-demo/deploy/auth-demo-centos7.service /etc/systemd/system/auth-demo.service
systemctl daemon-reload
systemctl enable --now auth-demo
systemctl status auth-demo
curl -s http://127.0.0.1:3000/health | /opt/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);console.log(h.backends,h.files.mode,h.relay.upstreamConfigured)})'
```

> Rocky/Alma/CentOS Stream 9（systemd ≥ 244）可改用 `deploy/auth-demo.service`，
> 它使用 `LoadCredential=` 与 `StateDirectory=`，隔离更严。

`/health` 应显示 `user=mysql`、`session=redis`、`chat=mysql`、`files=mysql+disk`，
以及 `process`、`files.disk` 指标。

---

## 3. 部署前端

```bash
cd chat-demo
npm ci
npm run build          # 默认生产包：chat. 前端直连 api. 后端
tar -czf chat-demo-dist-$(date +%F).tar.gz -C dist .
scp chat-demo-dist-$(date +%F).tar.gz root@SERVER:/tmp/
```

> 在 CentOS 7 服务器上直接构建时，把 `npm` 换成 `/opt/node/bin/npm`；
> Rspack 构建需要约 1–2 GB 临时内存，2C4G 机器建议在构建机完成。

服务器：

```bash
rm -rf /srv/chat-demo/dist.prev
mv /srv/chat-demo/dist /srv/chat-demo/dist.prev 2>/dev/null || true
mkdir -p /srv/chat-demo/dist
tar -xzf /tmp/chat-demo-dist-*.tar.gz -C /srv/chat-demo/dist
chown -R authsvc:authsvc /srv/chat-demo
```

如果改用同源反代，本地构建前设置：

```bash
APP_ENV=production BFF_BASE=/v1 AUTH_BASE=/auth npm run build
```

并把 `deploy/nginx-chat.conf` 的 CSP `connect-src` 去掉 API 域名、改为 `'self'`。

---

## 4. Nginx 与证书

先在前端构建机把前端 Nginx 配置传到服务器：

```bash
scp chat-demo/deploy/nginx-chat*.conf root@SERVER:/tmp/
```

服务器先用 HTTP-only 配置启动，完成 ACME 挑战：

```bash
mkdir -p /var/www/letsencrypt
cp /opt/auth-demo/deploy/nginx-api-http.conf /etc/nginx/conf.d/nginx-api.conf
cp /tmp/nginx-chat-http.conf              /etc/nginx/conf.d/nginx-chat.conf
nginx -t
systemctl enable --now nginx

certbot --nginx -d chat.shunkai-dg.cn -d api.shunkai-dg.cn \
  --agree-tos -m ops@example.com --redirect
```

签发成功后换成正式 TLS 配置（取消 `ssl_certificate` / `ssl_certificate_key` 注释）：

```bash
sed -i 's|# ssl_certificate |ssl_certificate |; s|# ssl_certificate_key |ssl_certificate_key |' \
  /tmp/nginx-chat.conf /opt/auth-demo/deploy/nginx-api.conf
cp /opt/auth-demo/deploy/nginx-api.conf /etc/nginx/conf.d/nginx-api.conf
cp /tmp/nginx-chat.conf                 /etc/nginx/conf.d/nginx-chat.conf
nginx -t
systemctl reload nginx

# 续期验证
certbot renew --dry-run
```

> CentOS 7 的 certbot 较旧；若 `--nginx` 插件不可用，用
> `certbot certonly --webroot -w /var/www/letsencrypt ...`，正式配置里已保留
> `/.well-known/acme-challenge/` 的 webroot。证书到期前 30 天由 certbot timer 自动续期。

SELinux 打开时允许 Nginx 反代：

```bash
setsebool -P httpd_can_network_connect 1
semanage fcontext -a -t httpd_sys_content_t '/srv/chat-demo/dist(/.*)?'
restorecon -Rv /srv/chat-demo/dist
```

防火墙：

```bash
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
# 22 端口只允许运维来源
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="运维IP/32" service name="ssh" accept'
firewall-cmd --reload
```

---

## 5. 备份

```bash
mkdir -p /var/backups/auth-demo
chown authsvc:authsvc /var/backups/auth-demo

cp /opt/auth-demo/deploy/auth-demo-backup.service /etc/systemd/system/
cp /opt/auth-demo/deploy/auth-demo-backup.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now auth-demo-backup.timer

# 手工验证一次
sudo -u authsvc env ENV_FILE=/etc/auth-demo/env /opt/node/bin/node /opt/auth-demo/scripts/backup.js
```

产物：

```text
/var/backups/auth-demo/
├── auth-db-YYYYMMDD-HHMMSS.sql.gz
├── auth-files-YYYYMMDD-HHMMSS.tar.gz
└── SHA256SUMS-YYYYMMDD-HHMMSS
```

- 默认保留 30 天（`BACKUP_RETENTION_DAYS`）。
- `OFFSITE_DIR` 指向挂载的异地目录时会自动复制并校验 SHA256。
- 备份目录必须与 MySQL/附件同时间点；恢复时先停服务，再恢复 DB 与 `files/blobs`。

恢复演练（在测试机）：

```bash
systemctl stop auth-demo
mysql -uroot -p auth_demo < auth-db-....sql
rm -rf /var/lib/auth-demo/files/blobs
tar -xzf auth-files-....tar.gz -C /var/lib/auth-demo/files
systemctl start auth-demo
curl -s http://127.0.0.1:3000/health
```

> `auth-db` 用 `mysqldump --databases` 生成，包含 `CREATE DATABASE/USE`，可直接导入。

---

## 6. 监控与日志

健康检查：

```bash
cp /opt/auth-demo/deploy/auth-demo-healthcheck.service /etc/systemd/system/
cp /opt/auth-demo/deploy/auth-demo-healthcheck.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now auth-demo-healthcheck.timer

# 手工执行
/opt/auth-demo/deploy/healthcheck.sh
```

`healthcheck.sh` 检查：`/health` 后端、上游配置、磁盘剩余（默认 <10% 失败）、
`auth-demo.service` 是否 active。接入企业微信/邮件/Alertmanager 时，在
`auth-demo-healthcheck.service` 里配置 `OnFailure=`。

日志：

```bash
journalctl -u auth-demo -f
tail -f /var/log/nginx/api.access.log /var/log/nginx/chat.access.log
```

- systemd journal 默认按大小/时间轮转；如需单独文件，配置 `/etc/systemd/journald.conf`
  的 `SystemMaxUse`。
- Nginx 日志由 `logrotate` 管理；`/v1/files/content` 已关闭访问日志，避免票据泄漏。

---

## 7. 生产验收

在任意能访问域名的机器：

```bash
API_BASE=https://api.shunkai-dg.cn \
WEB_BASE=https://chat.shunkai-dg.cn \
  bash auth-demo/deploy/verify-production.sh
```

检查项：`/health` 后端与磁盘、首页 `#root`、CSP/HSTS、公钥接口、CORS 预检、TLS 证书。

人工验收（K2）：

1. 登录 → 新建会话 → 流式回答 → 刷新，历史仍在。
2. 第二台设备登录同一账号，能看到同一历史。
3. 上传图片 → 清空本机 IndexedDB → 刷新，图片仍能显示。
4. 停止生成 → 刷新，状态为已停止。
5. 断网重连，不重复 token（看 SSE `id` 与最终文本）。
6. TTS/ASR 正常，浏览器 Network 中没有 `api.deepseek.com`、没有 `x-api-key`。
7. 导入历史 ZIP 后，用户登录能看到完整历史与图片。
8. 管理员锁定账号，旧 Token 立即失效；解锁后可重新登录。
9. 越权访问他人会话/附件返回 404。

压测（K5）建议：

```bash
# 登录并发
hey -n 100 -c 10 -m POST -H 'content-type: application/json' -d @login.json \
  https://api.shunkai-dg.cn/auth/login

# SSE 并发（用真实 Token）
hey -n 20 -c 2 -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --timeout 300s -d @chat.json https://api.shunkai-dg.cn/v1/chat/stream
```

观察 `MemoryHigh/MemoryMax`、`STREAM_MAX_*`、MySQL 连接数、Redis 内存与磁盘水位。

### 故障演练（K3）

| 场景 | 预期 | 验证方式 |
| --- | --- | --- |
| MySQL 停止 | `/health` 失败；登录/聊天返回 503，不返回 401 | `systemctl stop mysqld`，观察 `auth-demo` 日志与健康检查 |
| Redis 停止 | 受保护接口 503；前端提示服务暂不可用，不误登出 | `systemctl stop redis`，登录/聊天各试一次 |
| 上游 5xx/超时 | `502/504`；首帧前失败不写 SSE 头 | `UPSTREAM_BASE_URL` 指向 mock 上游，用 `/fail 500`、`/delay 3s` |
| 服务重启 | 历史从 MySQL 恢复；残留流按中断处理 | `systemctl restart auth-demo` 后刷新页面 |
| 磁盘写满 | 上传返回明确 4xx/5xx；备份失败告警 | 在测试盘 `fallocate` 占满后上传一个小文件 |

演练前先备份，演练后恢复并确认 `/health` 与附件读取正常。

---

## 8. 回滚

1. 前端：`mv /srv/chat-demo/dist /srv/chat-demo/dist.failed && mv /srv/chat-demo/dist.prev /srv/chat-demo/dist`
2. 后端：`systemctl stop auth-demo`，用 `/opt/auth-demo.prev` 覆盖 `/opt/auth-demo`，
   重新 `npm ci --omit=dev`，启动；数据库迁移是向前兼容的，不回滚 DDL。
3. Nginx：`cp` 上一版配置，`nginx -t && systemctl reload nginx`。
4. 若升级写坏数据：先停服务，用最近一次备份恢复 DB + `files/blobs`，再启动。

---

## 9. 上线检查清单

- [ ] DNS A 记录指向公网 IP，ICP 备案完成
- [ ] 证书签发成功，`certbot renew --dry-run` 通过
- [ ] `/health` 显示 mysql/redis/mysql、files local、upstreamConfigured
- [ ] `CORS_ORIGINS` 包含 chat 域名，`FILES_CORP` 与部署形态匹配
- [ ] 浏览器无 `x-api-key`、无 `api.deepseek.com` 直连
- [ ] 登录、聊天流、停止、附件上传/跨设备显示、语音、导入、账号 CLI 验证
- [ ] 备份 timer 已启用，手工备份与恢复演练通过
- [ ] 健康检查 timer 已启用，告警通道已接
- [ ] 防火墙只开 80/443（+受限 22），MySQL/Redis 只监听回环
- [ ] `journalctl`/Nginx 日志轮转与磁盘水位正常
- [ ] 已记录上一版产物与回滚步骤
