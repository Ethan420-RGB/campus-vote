// 冒烟测试：自动拉起两个实例（正常 / 已截止），覆盖主要接口与防重复投票逻辑。
// 用法：node scripts/smoke-test.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

const cases = [
  { name: '正常实例', port: 8891, env: { VOTE_DEADLINE: '2099-12-31T23:59:59+08:00' }, db: 'test-open.db' },
  { name: '已截止实例', port: 8892, env: { VOTE_DEADLINE: '2020-01-01T00:00:00+08:00' }, db: 'test-closed.db' },
];

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

function start(c) {
  const dbPath = path.join(root, 'data', c.db);
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  const child = spawn(node, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(c.port), DB_PATH: dbPath, ADMIN_PASSWORD: 'test-pass-123', ...c.env },
    stdio: 'ignore',
  });
  return { child, base: `http://127.0.0.1:${c.port}` };
}

async function waitReady(base, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function jar() {
  const store = new Map();
  return {
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const sc of res.headers.getSetCookie?.() || []) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        store.set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
    get: (k) => store.get(k),
  };
}

async function run(base) {
  const c = jar();

  let res = await fetch(base + '/api/config');
  c.absorb(res);
  let cfg = await res.json();
  check('GET /api/config 返回 200', res.status === 200);
  check('选手数量为 6', cfg.players?.length === 6, `实际 ${cfg.players?.length}`);
  check('首次访问未投票', cfg.hasVoted === false);
  check('已下发会话 Cookie', Boolean(c.get('cv_sid')));
  check('剩余时间字段存在', typeof cfg.deadline?.ms === 'number');

  res = await fetch(base + '/', { headers: { cookie: c.header() } });
  const html = await res.text();
  check('首页 200 且含标题', res.status === 200 && html.includes('作品投票'));

  res = await fetch(base + '/img/player-1.svg');
  check('静态图片可访问', res.status === 200 && (res.headers.get('content-type') || '').includes('svg'));

  res = await fetch(base + '/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: c.header() },
    body: JSON.stringify({ playerId: 'p03' }),
  });
  c.absorb(res);
  let vote = await res.json();
  check('首次投票成功', res.status === 200 && vote.ok === true);
  check('返回“明天可再投”提示', String(vote.message || '').includes('明天'));
  check('返回下次可投时间', typeof vote.nextVoteAt === 'number' && vote.nextVoteAt > Date.now());

  res = await fetch(base + '/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: c.header() },
    body: JSON.stringify({ playerId: 'p01' }),
  });
  vote = await res.json();
  check('同一身份再投被拒（409）', res.status === 409 && vote.code === 'ALREADY_VOTED');

  res = await fetch(base + '/api/config', { headers: { cookie: c.header() } });
  cfg = await res.json();
  check('配置接口反映已投票状态', cfg.hasVoted === true);

  // 换一个“浏览器”（不携带 Cookie）应被视为另一个投票人
  const other = await fetch(base + '/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'p01' }),
  });
  const otherBody = await other.json();
  check('不同身份可各自投票', other.status === 200 && otherBody.ok === true);

  res = await fetch(base + '/admin', { redirect: 'manual' });
  check('未登录访问后台被重定向', res.status === 302 && (res.headers.get('location') || '').includes('/admin/login'));

  res = await fetch(base + '/admin/data.json');
  check('未登录接口返回 401', res.status === 401);

  res = await fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=wrong' });
  check('错误密码被拒', res.status === 401);

  const adminJar = jar();
  res = await fetch(base + '/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=test-pass-123',
    redirect: 'manual',
  });
  adminJar.absorb(res);
  check('正确密码登录成功', res.status === 302 && Boolean(adminJar.get('cv_admin')));

  res = await fetch(base + '/admin/data.json', { headers: { cookie: adminJar.header() } });
  const data = await res.json();
  check('后台数据可读', res.status === 200 && data.overview.totalVotes === 2);
  check('选手票数合计为 2', data.players.reduce((s, p) => s + p.votes, 0) === 2);
  check('记录里含 IP 与身份类型', data.recent.every((v) => v.ip && v.type));
  check('openid 已脱敏（cookie 模式）', data.recent.every((v) => v.openid === ''));

  res = await fetch(base + '/admin/export.csv', { headers: { cookie: adminJar.header() } });
  const csvBuf = new Uint8Array(await res.arrayBuffer());
  const csv = new TextDecoder('utf-8').decode(csvBuf);
  check('导出票数 CSV 正常', res.status === 200 && csv.includes('票数') && csv.includes('合计'));
  check('CSV 带 BOM（Excel 不乱码）', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf);

  res = await fetch(base + '/admin/export.csv?type=votes', { headers: { cookie: adminJar.header() } });
  const csv2 = await res.text();
  check('导出明细 CSV 正常', res.status === 200 && csv2.includes('投票时间'));
}

async function runClosed(base) {
  const res = await fetch(base + '/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'p01' }),
  });
  const body = await res.json();
  check('截止后投票被拒（403 CLOSED）', res.status === 403 && body.code === 'CLOSED');

  const cfgRes = await fetch(base + '/api/config');
  const cfg = await cfgRes.json();
  check('截止后配置标记 closed', cfg.deadline?.closed === true);
  check('截止后仍可拿到选手列表', cfg.players?.length > 0);
}

const running = [];
try {
  for (const c of cases) {
    const { child, base } = start(c);
    running.push(child);
    const ok = await waitReady(base);
    console.log(`\n[${c.name}] ${ok ? '已启动' : '启动失败'} ${base}`);
    if (!ok) { failures++; continue; }
    if (c.name === '正常实例') await run(base);
    else await runClosed(base);
  }
} finally {
  for (const child of running) child.kill();
}

// 清理测试数据库
for (const c of cases) {
  for (const p of [c.db, c.db + '-wal', c.db + '-shm']) {
    try { fs.unlinkSync(path.join(root, 'data', p)); } catch { /* ignore */ }
  }
}

console.log(`\n${failures === 0 ? '全部通过 ✓' : failures + ' 项未通过 ✗'}`);
process.exit(failures === 0 ? 0 : 1);
