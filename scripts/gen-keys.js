'use strict';
/**
 * 生成 RSA-2048 密钥对（方案 A-B-04）。
 * 私钥权限设为 600（Windows 上尽力而为）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const outDir = path.join(__dirname, '..', 'secrets');
fs.mkdirSync(outDir, { recursive: true });

const privPath = path.join(outDir, 'rsa_private.pem');
const pubPath = path.join(outDir, 'rsa_public.pem');

if (fs.existsSync(privPath) && !process.argv.includes('--force')) {
  console.log('密钥已存在，跳过。如需重新生成请加 --force');
  process.exit(0);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

try { fs.chmodSync(privPath, 0o600); } catch { /* Windows 忽略 */ }

console.log('已生成密钥对：');
console.log('  私钥 ' + privPath);
console.log('  公钥 ' + pubPath);
console.log('\n私钥请勿提交版本控制；生产环境应通过 systemd LoadCredential= 注入。');
