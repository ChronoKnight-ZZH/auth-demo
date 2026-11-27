const { createCors } = require('../src/middleware/cors');

function run(mw, headers, method = 'GET') {
  const out = {};
  let passed = false;
  let statusCode = null;
  let jsonBody = null;
  let ended = false;
  const req = { headers, method };
  // 模拟 express：status() 返回 res 本身，可继续 .json() / .end()
  const res = {
    setHeader: (k, v) => {
      out[k] = v;
    },
    status: (c) => {
      statusCode = c;
      return res;
    },
    end: () => {
      ended = true;
      return res;
    },
    json: (o) => {
      jsonBody = o;
      ended = true;
      return res;
    },
  };
  mw(req, res, () => {
    passed = true;
  });
  return { headers: out, passed, status: statusCode, json: jsonBody, ended };
}

const ORIGIN = 'https://chat.shunkai-dg.cn';

// A: 未配置 CORS_ORIGINS —— 同源部署，应完全直通、零响应头
const a = run(createCors({ origins: [] }), { origin: ORIGIN });
console.log('A empty-config:', JSON.stringify(a));
if (!a.passed || Object.keys(a.headers).length !== 0) throw new Error('A failed');

const mw = createCors({ origins: [ORIGIN] });

// B: 白名单内 GET —— 回显 Origin + Credentials + Expose，并 next()
const b = run(mw, { origin: ORIGIN });
console.log('B allowed GET:', JSON.stringify(b));
if (!b.passed || b.headers['Access-Control-Allow-Origin'] !== ORIGIN ||
    b.headers['Access-Control-Allow-Credentials'] !== 'true' ||
    !b.headers['Access-Control-Expose-Headers'].includes('Retry-After')) throw new Error('B failed');

// C: 预检 OPTIONS（大小写不同的 Origin）—— 204 + Methods/Headers/Max-Age，不 next
const c = run(mw, { origin: 'https://CHAT.shunkai-DG.cn' }, 'OPTIONS');
console.log('C preflight:', JSON.stringify(c));
if (c.passed || c.status !== 204 || !c.ended ||
    !c.headers['Access-Control-Allow-Headers'].includes('X-File-Name') ||
    !c.headers['Access-Control-Allow-Headers'].includes('Idempotency-Key') ||
    !c.headers['Access-Control-Allow-Methods'].includes('PUT') ||
    !c.headers['Access-Control-Allow-Methods'].includes('PATCH') ||
    c.headers['Vary'] !== 'Origin') throw new Error('C failed');

// D: 非白名单预检 —— 403，且不泄露任何 Allow-Origin
const d = run(mw, { origin: 'https://evil.example' }, 'OPTIONS');
console.log('D evil preflight:', JSON.stringify(d));
if (d.status !== 403 || d.headers['Access-Control-Allow-Origin']) throw new Error('D failed');

// E: 非白名单普通请求 —— 不加头，交后续路由（404/鉴权自行处理）
const e = run(mw, { origin: 'https://evil.example' });
console.log('E evil GET:', JSON.stringify(e));
if (!e.passed || Object.keys(e.headers).length !== 0) throw new Error('E failed');

// F: 无 Origin（curl、健康检查、<img> 子资源）—— 直通零头
const f = run(mw, {});
console.log('F no origin:', JSON.stringify(f));
if (!f.passed || Object.keys(f.headers).length !== 0) throw new Error('F failed');

// G: 通配符配置 —— 反射任意来源
const g = run(createCors({ origins: ['*'] }), { origin: 'https://anything.test' });
console.log('G wildcard:', JSON.stringify(g));
if (!g.passed || g.headers['Access-Control-Allow-Origin'] !== 'https://anything.test') throw new Error('G failed');

console.log('\nALL CORS CASES PASS');
