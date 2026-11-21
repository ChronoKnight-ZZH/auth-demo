'use strict';
/**
 * 构建产物：把运行所需文件复制到 dist/，不做 JS 打包。
 *
 * 为什么不 bundle：
 *   - argon2 是原生模块，单文件打包后仍需要 node_modules 里的 .node 二进制；
 *   - mysql2 / ioredis 也有动态加载路径，bundle 只会增加风险；
 *   - 本服务本来就是 CommonJS，直接复制即可运行。
 *
 * 不进入产物的内容：
 *   - .env、secrets/：必须由部署环境注入；
 *   - node_modules/：目标机执行 npm ci --omit=dev；
 *   - test/：运行时不依赖。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');

function copy(from, to) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少构建输入: ${from}`);
  }
  const target = path.join(out, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return source;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? countFiles(full) : 1;
  }
  return total;
}

function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const entries = [
    ['src', 'src'],
    ['public', 'public'],
    ['migrations', 'migrations'],
    ['scripts', 'scripts'],
    ['deploy', 'deploy'],
    ['.env.example', '.env.example'],
    ['package.json', 'package.json'],
    ['package-lock.json', 'package-lock.json'],
  ];

  for (const [from, to] of entries) {
    copy(from, to);
  }

  fs.writeFileSync(
    path.join(out, 'DEPLOY.md'),
    [
      '# auth-demo 构建产物',
      '',
      '本目录由 `npm run build` 生成，入口是 `src/server.js`。',
      '',
      '## 部署',
      '',
      '```bash',
      'npm ci --omit=dev',
      '# 提供 .env（参考 .env.example）',
      '# 提供 RSA 私钥/公钥与 PEPPER（推荐 systemd LoadCredential）',
      'node src/server.js',
      '```',
      '',
      '本目录不包含 `.env`、`secrets/`、`node_modules/`、`test/`。',
      '',
    ].join('\n')
  );

  // 构建时明确检查：机密与本地配置绝不能被打进产物
  for (const forbidden of ['secrets', '.env', 'node_modules', 'test']) {
    if (fs.existsSync(path.join(out, forbidden))) {
      throw new Error(`产物中不应包含 ${forbidden}`);
    }
  }

  const files = countFiles(out);
  console.log('构建完成: dist/');
  console.log(`  文件数: ${files}`);
  console.log('  入口  : dist/src/server.js');
  console.log('  启动  : node dist/src/server.js');
  console.log('');
  console.log('部署时请在 dist/ 中提供 .env 与 RSA 密钥，并执行:');
  console.log('  npm ci --omit=dev');
}

main();
