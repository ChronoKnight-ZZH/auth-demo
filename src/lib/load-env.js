'use strict';
/**
 * 极简 .env 加载器（零依赖，避免引入 dotenv）。
 * 已存在的环境变量优先，不覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(file) {
  const p = file || path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return false;
  const content = fs.readFileSync(p, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

module.exports = { loadEnv };