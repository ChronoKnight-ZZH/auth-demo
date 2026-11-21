'use strict';
/**
 * 前端互通性验证：模拟浏览器 WebCrypto 的 RSA-OAEP(SHA-256) 加密路径，
 * 确认后端能解密。这是 A-U-02 的等价验证（不依赖浏览器）。
 * 用法：node scripts/verify-webcrypto.js
 */
const crypto = require('node:crypto');
const { loadEnv } = require('../src/lib/load-env');
loadEnv();

const { publicKeyPem, decryptCredentials, decodePayload } = require('../src/crypto/rsa');

async function main() {
  const pem = publicKeyPem();

  // 1) 与浏览器一致：PEM -> DER -> importKey
  const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, '')
                 .replace(/-----END PUBLIC KEY-----/, '')
                 .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');

  const webKey = crypto.createPublicKey({
    key: der, format: 'der', type: 'spki',
  });
  console.log('公钥可从 PEM/DER 正确导入:', webKey.asymmetricKeyType);

  // 2) 用与前端等价的参数加密（OAEP + SHA-256）
  const payload = Buffer.from('v1\n5\naliceAlice@Passw0rd', 'utf8');
  const ct = crypto.publicEncrypt(
    { key: webKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    payload
  ).toString('base64');
  console.log('密文长度(base64):', ct.length, '(RSA-2048 -> 344 字符)');

  // 3) 后端解密
  const pt = decryptCredentials(ct);
  const parsed = decodePayload(pt);
  console.log('解密结果:', JSON.stringify(parsed));

  const ok = parsed && parsed.username === 'alice' && parsed.password === 'Alice@Passw0rd';
  console.log(ok ? '\nPASS  前端 WebCrypto 路径与后端协议互通' : '\nFAIL  协议不一致');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });