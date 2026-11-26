'use strict';
/**
 * 生成本地自签名证书（零依赖，Node 内置 crypto + 手写 DER 编码）。
 *
 * 用途：把本地 API 服务升级为 https，用于「浏览器直连本地 HTTPS」的联调测试。
 * 生产环境证书由 Nginx + Let's Encrypt 终结，本脚本只服务于本地/测试环境。
 *
 * 用法：
 *   node scripts/gen-cert.js                     # 生成到 secrets/tls_cert.pem + secrets/tls_key.pem
 *   node scripts/gen-cert.js --force             # 覆盖已存在的证书
 *   node scripts/gen-cert.js --days 30           # 有效期 30 天（默认 365）
 *   node scripts/gen-cert.js --host 192.168.1.10 --host auth.local
 *   node scripts/gen-cert.js --out-dir /tmp/tls  # 指定输出目录
 *
 * 产物：
 *   secrets/tls_cert.pem   自签名证书（CN=localhost，SAN 含 localhost / 127.0.0.1 / ::1）
 *   secrets/tls_key.pem    私钥（PKCS#8，权限 600，Windows 尽力而为）
 *
 * 自签名证书浏览器会告警；可把 tls_cert.pem 导入系统信任库，或用 curl -k。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { parseArgs } = require('node:util');

// ---------------------------------------------------------------- DER 编码器

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** tag + length + content */
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));

/** 正整数编码（补 0x00 前缀避免被当成负数） */
function derInt(value) {
  let buf = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from([value]);
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  buf = buf.subarray(i);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function derBool(value) {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

function derOctet(content) {
  return tlv(0x04, content);
}

function derUtf8(text) {
  return tlv(0x0c, Buffer.from(text, 'utf8'));
}

function derIa5(text) {
  return tlv(0x16, Buffer.from(text, 'ascii'));
}

function derBitString(content, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
}

/** 显式标签 [n]（constructed context） */
function derExplicit(n, content) {
  return tlv(0xa0 | n, content);
}

/** OID 编码：2.5.4.3 / 1.2.840.113549.1.1.11 … */
function derOid(dotted) {
  const parts = String(dotted).split('.').map((n) => Number(n));
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`非法 OID: ${dotted}`);
  }
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let v = part;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime：YYMMDDHHMMSSZ（1950-2049 有效） */
function derUtcTime(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const s =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

function derName(cn, o) {
  const rdns = [
    set(seq(derOid(OID.organization), derUtf8(o))),
    set(seq(derOid(OID.commonName), derUtf8(cn))),
  ];
  return seq(...rdns);
}

/** 扩展项：SEQUENCE { OID, [critical BOOLEAN], OCTET STRING } */
function derExtension(oid, value, critical = false) {
  const parts = [derOid(oid)];
  if (critical) parts.push(derBool(true));
  parts.push(derOctet(value));
  return seq(...parts);
}

function ipToBuffer(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map((n) => Number(n)));
  if (net.isIPv6(ip)) return ipv6ToBytes(ip);
  return null;
}

function ipv6ToBytes(ip) {
  const parts = ip.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
  const out = [];
  for (const g of groups) out.push(parseInt(g || '0', 16));
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return buf;
}

/** SAN：dNSName [2] / iPAddress [7] */
function derSan(dnsNames, ips) {
  const entries = [];
  for (const dns of dnsNames) entries.push(tlv(0x82, Buffer.from(dns, 'ascii')));
  for (const ip of ips) {
    const buf = ipToBuffer(ip);
    if (buf) entries.push(tlv(0x87, buf));
  }
  return seq(...entries);
}

/**
 * 生成自签名证书。
 * @param {object} opts
 * @param {string} opts.commonName 证书 CN，默认 localhost
 * @param {string} opts.organization 组织名，默认 auth-demo local
 * @param {string[]} opts.dns 额外 DNS SAN
 * @param {string[]} opts.ips 额外 IP SAN
 * @param {number} opts.days 有效期天数
 * @returns {{certPem: string, keyPem: string, fingerprint: string, notAfter: string}}
 */
function generateCert(opts = {}) {
  const commonName = opts.commonName || 'localhost';
  const organization = opts.organization || 'auth-demo local';
  const dnsNames = [...new Set(['localhost', ...(opts.dns || [])])];
  const ips = [...new Set(['127.0.0.1', '::1', ...(opts.ips || [])])];
  const days = Number(opts.days) > 0 ? Number(opts.days) : 365;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // 保证为正整数
  if (serial[0] === 0) serial[0] = 0x01;

  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 24 * 3600 * 1000);

  const algId = seq(derOid(OID.sha256WithRSA), derNull());

  const basicConstraints = derExtension(OID.basicConstraints, seq(derBool(true)), true);
  // digitalSignature(0) + keyEncipherment(2) + keyCertSign(5)
  const keyUsage = derExtension(OID.keyUsage, derBitString(Buffer.from([0xa4]), 2), true);
  const extKeyUsage = derExtension(OID.extKeyUsage, seq(derOid(OID.serverAuth), derOid(OID.clientAuth)));
  const san = derExtension(OID.subjectAltName, derSan(dnsNames, ips));

  const tbs = seq(
    derExplicit(0, derInt(2)), // version v3
    derInt(serial),
    algId,
    derName(commonName, organization),
    seq(derUtcTime(notBefore), derUtcTime(notAfter)),
    derName(commonName, organization),
    spki,
    derExplicit(3, seq(basicConstraints, keyUsage, extKeyUsage, san))
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, algId, derBitString(signature));
  const certPem = '-----BEGIN CERTIFICATE-----\n' + chunk(certDer.toString('base64')) + '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  return {
    certPem,
    keyPem,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(certDer).digest('base64'),
    notAfter: notAfter.toISOString(),
  };
}

function chunk(base64, size = 64) {
  const lines = [];
  for (let i = 0; i < base64.length; i += size) lines.push(base64.slice(i, i + size));
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        force: { type: 'boolean', default: false },
        days: { type: 'string', default: '365' },
        cn: { type: 'string', default: 'localhost' },
        host: { type: 'string', multiple: true, default: [] },
        'out-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    console.error(error.message);
    console.error('用法：node scripts/gen-cert.js [--force] [--days 365] [--cn localhost] [--host 1.2.3.4] [--out-dir secrets]');
    process.exit(2);
  }

  if (values.help) {
    console.log(`用法：node scripts/gen-cert.js [选项]

选项：
  --force            覆盖已存在的证书
  --days <n>         有效期天数，默认 365
  --cn <name>        证书 CN，默认 localhost
  --host <h>         额外 SAN（DNS 或 IP），可重复
  --out-dir <dir>    输出目录，默认 <仓库>/secrets
  -h, --help         显示帮助`);
    return;
  }

  const outDir = values['out-dir']
    ? path.resolve(values['out-dir'])
    : path.join(__dirname, '..', 'secrets');
  const certPath = path.join(outDir, 'tls_cert.pem');
  const keyPath = path.join(outDir, 'tls_key.pem');

  fs.mkdirSync(outDir, { recursive: true });

  if ((fs.existsSync(certPath) || fs.existsSync(keyPath)) && !values.force) {
    console.log('证书已存在，跳过。如需重新生成请加 --force');
    console.log('  证书 ' + certPath);
    console.log('  私钥 ' + keyPath);
    return;
  }

  const extraHosts = values.host || [];
  const dns = extraHosts.filter((h) => !net.isIP(h));
  const ips = extraHosts.filter((h) => net.isIP(h));

  const { certPem, keyPem, fingerprint, notAfter } = generateCert({
    commonName: values.cn,
    dns,
    ips,
    days: Number(values.days),
  });

  fs.writeFileSync(certPath, certPem, { mode: 0o644 });
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows 忽略 */ }

  console.log('已生成自签名证书：');
  console.log('  证书 ' + certPath);
  console.log('  私钥 ' + keyPath);
  console.log('  指纹 ' + fingerprint);
  console.log('  有效期至 ' + notAfter);
  console.log('\n本地启用 HTTPS：');
  console.log('  TLS_ENABLED=1');
  console.log(`  TLS_CERT_PATH=${certPath}`);
  console.log(`  TLS_KEY_PATH=${keyPath}`);
  console.log('\n私钥请勿提交版本控制；生产环境证书由 Nginx + Let\'s Encrypt 终结。');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[生成失败] ' + e.message);
    process.exit(1);
  });
}

module.exports = { generateCert };
