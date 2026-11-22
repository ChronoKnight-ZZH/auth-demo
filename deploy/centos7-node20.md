# CentOS 7(glibc 2.17)部署:免改代码上 Node 20

## 背景与结论

CentOS 7 自带 glibc 2.17,yum 最高只有 Node 16;而 Node 18+ 官方二进制要求 glibc ≥ 2.28。
本项目服务端用到全局 `fetch` / Web Streams(Node 18+),因此 yum 装的 Node 16 上
`/v1/chat/stream` 会报 `UPSTREAM_ERROR: fetch is not defined`(登录链路不受影响)。

**出路:[unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/download/release/)
提供专为 glibc 2.17 重编译的官方社区构建 `linux-x64-glibc-217`,解压即用,代码零改动。**

本目录中的 auth-demo 已实测依赖兼容:

| 组件 | 兼容性 |
| --- | --- |
| express 5 / mysql2 / ioredis | 纯 JS,glibc-217 构建的 Node 20 下无问题 |
| argon2@0.41(N-API) | 自带 `prebuilds/linux-x64/*.glibc.node`,不需要编译 |
| MySQL 8.4 / Redis 7.2 | CentOS 7 官方源/Remi 可装(见主 README);装不上则用远程实例 |

> 非官方构建的安全责任:二进制由 Node.js 社区 Richard Lau 维护、nodejs.org 官方站点链接推荐,
> 但不在 Node TSC 发布流程内。上线前**必须**核对 SHA256(步骤 2),并留存本文件记录所用版本。

## 部署步骤(root 执行)

### 1) 选择版本并下载

以 v20.20.2(截至 2026-03 的 Node 20 最新补丁版)为例;
版本清单见 <https://unofficial-builds.nodejs.org/download/release/>。

```bash
VER=v20.20.2
F=node-${VER}-linux-x64-glibc-217.tar.xz
cd /usr/local/src
curl -fSLO "https://unofficial-builds.nodejs.org/download/release/${VER}/${F}"
curl -fSLO "https://unofficial-builds.nodejs.org/download/release/${VER}/SHASUMS256.txt"
```

机器不能直接出网时,在能上网的机器下载后 `scp` 过去(两个文件都要)。

### 2) 校验(不可跳过)

```bash
grep " ${F}\$" SHASUMS256.txt | sha256sum -c -
# 期望输出: node-v20.20.2-linux-x64-glibc-217.tar.xz: OK
```

同时把上面 `SHASUMS256.txt` 里该文件的哈希值抄进变更单留档。

### 3) 安装到 /opt/node,不碰 yum 的 node 16

```bash
mkdir -p /opt/node
tar -xJf "${F}" -C /opt/node --strip-components=1
/opt/node/bin/node -v          # 应输出 v20.20.2
/opt/node/bin/node -e "console.log(typeof fetch, typeof require('stream').Readable.fromWeb)"
# 期望: function function   —— 这两项就是 Node 16 缺失、本项目依赖的能力
```

> 如果 `node -v` 报 `GLIBC_xxx not found`,说明拿错了包(拿到的是标准 linux-x64 构建),
> 重新确认文件名里带 `glibc-217`。

### 4) 让 systemd 用它(不改 PATH、不影响系统其他程序)

主 README 的单元文件 `ExecStart=/usr/bin/node ...`,改为绝对路径:

```ini
ExecStart=/opt/node/bin/node --max-old-space-size=384 src/server.js
```

`deploy/auth-demo.service` 里的加固项(`ProtectSystem=strict` 等)与该布局兼容:
`/opt/node` 只需可读可执行。npm 也在同目录,部署构建用:

```bash
cd /opt/auth-demo
/opt/node/bin/npm ci --omit=dev
/opt/node/bin/node src/server.js   # 手工验证一次
```

需要交互使用时(仅运维习惯,非必需):

```bash
cat > /etc/profile.d/node20.sh <<'EOF'
export PATH=/opt/node/bin:$PATH
EOF
```

### 5) 回退

删掉 `/opt/node` 并把 `ExecStart` 改回原值即可,yum 的 node 16 全程未被替换。

## 备选路线(不推荐,仅备查)

- **留在 Node 16 + undici 兼容层**:新增 `src/lib/http-client.js`(约 20 行,
  `typeof fetch === 'undefined'` 时回退 `require('undici').fetch`,proxy.js 的
  `Readable.fromWeb` 加手写兜底)。可行,但把项目永久钉死在 EOL 运行时上,
  且 Node 16 的 TLS/HTTP 栈已多年无安全更新 —— 用于登录系统尤其不合适。
- **容器**:CentOS 7 上跑 docker 镜像(node:20-alpine),彻底绕开 glibc,但引入容器栈。
- **换系统**:Rocky 8/9、Debian 10+ 直接 NodeSource 装 Node 20/22,glibc 天然满足。

## 验收(与主 README §测试与验收 对应)

```bash
cd /opt/auth-demo
/opt/node/bin/node src/server.js &        # 或用 systemd 启动
/opt/node/bin/node scripts/smoke.js       # 登录链路 16 项
# 中转链路端到端(自动拉起本地 mock 上游,不产生真实调用):
/opt/node/bin/node scripts/smoke-stream.js
```

全部通过后 `systemctl restart auth-demo` 并观察 `/health` 的
`relay.upstreamConfigured=true`、`/v1/chat/stream` 正常出流。
