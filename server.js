// 校园活动线上投票 —— 服务端（零第三方依赖：node:http + node:sqlite + 内置 fetch）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './src/config.js';
import {
  db, players, playerMap, lastVoteOf, addVote, countsByPlayer, overview,
  votesFromIpSince, recentVotes, allVotesForCsv, suspiciousIps,
} from './src/db.js';
import { sign, verify, parseCookies, randomId, makeState, checkState, safeEqual } from './src/security.js';
import { isWeChatUA, buildAuthUrl, exchangeCodeForOpenId } from './src/wechat.js';
import { toCsv, formatTime, maskOpenId } from './src/csv.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- 小工具
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end();
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  const raw = req.socket.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

function isHttps(req) {
  if ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return config.baseUrl.startsWith('https://');
}

function cookie(name, value, { maxAge = config.cookieMaxAgeSec, req, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (httpOnly) parts.push('HttpOnly');
  // 微信内是 https，必须带 Secure；本地 http 调试时不带，否则浏览器不保存
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('BAD_JSON');
  }
}

function serveFile(req, res, absPath, cacheSeconds = 0) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(absPath);
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': stat.size,
    'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(absPath).pipe(res);
}

// ---------------------------------------------------------------- 身份识别
function readSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[config.cookieName];
  if (!token) return null;
  const payload = verify(token);
  if (!payload || typeof payload.k !== 'string') return null;
  // 微信用 openid 精确识别；cookie 模式用随机设备标识
  return { voterKey: payload.k, identityType: payload.t === 'wechat' ? 'wechat' : 'cookie', openid: payload.o || null };
}

function issueSession(req, res, { voterKey, identityType, openid }) {
  const token = sign({ k: voterKey, t: identityType, o: openid || null, ts: Date.now() });
  return cookie(config.cookieName, token, { req });
}

function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const payload = verify(cookies[config.adminCookieName]);
  return Boolean(payload && payload.role === 'admin' && Date.now() - payload.ts < config.adminSessionSec * 1000);
}

// ---------------------------------------------------------------- 投票窗口
function nextAllowedAt(lastVote) {
  if (!lastVote) return 0;
  if (config.windowMode === 'calendar') {
    const dayIndex = (t) => Math.floor((t + 8 * 3600 * 1000) / 86400000);
    const today = dayIndex(Date.now());
    if (dayIndex(lastVote.created_at) === today) return (today + 1) * 86400000 - 8 * 3600 * 1000;
    return 0;
  }
  return lastVote.created_at + config.windowMs;
}

function voteState(voterKey) {
  const last = voterKey ? lastVoteOf(voterKey) : null;
  const nextAt = nextAllowedAt(last);
  return { hasVoted: Boolean(last) && nextAt > Date.now(), nextVoteAt: nextAt || null, lastVote: last };
}

// ---------------------------------------------------------------- 路由处理
function handleConfig(req, res) {
  let session = readSession(req);
  const cookies = [];
  if (!session) {
    // 首次访问：cookie 模式直接发一个匿名身份；微信模式若在微信内则要求先授权
    const ua = req.headers['user-agent'] || '';
    if (config.wx.enabled && isWeChatUA(ua)) {
      return sendJson(res, 200, {
        needWeChatAuth: true,
        authUrl: buildAuthUrl(makeState(), '/'),
        event: config.event,
        deadline: { ms: config.deadlineMs, label: config.deadlineLabel, closed: Date.now() > config.deadlineMs },
        closedText: config.closedText,
        players: [],
      });
    }
    const voterKey = `ck:${randomId(12)}`;
    session = { voterKey, identityType: 'cookie', openid: null };
    cookies.push(issueSession(req, res, session));
  }

  const state = voteState(session.voterKey);
  const withVotes = config.showCounts ? countsByPlayer() : players;
  const payload = {
    event: config.event,
    deadline: { ms: config.deadlineMs, label: config.deadlineLabel, closed: Date.now() > config.deadlineMs },
    closedText: config.closedText,
    windowMode: config.windowMode,
    identityType: session.identityType,
    hasVoted: state.hasVoted,
    nextVoteAt: state.nextVoteAt,
    showCounts: config.showCounts,
    players: withVotes,
    serverNow: Date.now(),
    wxEnabled: config.wx.enabled,
  };
  if (!cookies.length) return sendJson(res, 200, payload);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': cookies,
  });
  res.end(JSON.stringify(payload));
}

async function handleVote(req, res) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求格式不正确' });
  }

  const player = playerMap.get(String(body.playerId || ''));
  if (!player) return sendJson(res, 404, { ok: false, code: 'NO_PLAYER', message: '选手不存在' });

  // 截止时间锁（服务端为准，改前端也没用）
  if (Date.now() > config.deadlineMs) {
    return sendJson(res, 403, { ok: false, code: 'CLOSED', message: config.closedText });
  }

  // 身份：微信模式优先用 openid；否则用签名 cookie（首次自动下发）
  let session = readSession(req);
  let setCookie;
  if (!session) {
    if (config.wx.enabled && isWeChatUA(ua)) {
      return sendJson(res, 401, {
        ok: false,
        code: 'NEED_WECHAT_AUTH',
        message: '请先完成微信授权',
        authUrl: buildAuthUrl(makeState()),
      });
    }
    session = { voterKey: `ck:${randomId(12)}`, identityType: 'cookie', openid: null };
    setCookie = issueSession(req, res, session);
  }

  // IP 软限流：只拦脚本洪水，不按“一 IP 一票”封禁（校园出口经常几千人共用）
  if (config.ipLimit.max > 0) {
    const recent = votesFromIpSince(ip, Date.now() - config.ipLimit.windowMs);
    if (recent >= config.ipLimit.max) {
      return sendJson(res, 429, {
        ok: false,
        code: 'IP_TOO_MANY',
        message: '该网络投票过于频繁，请稍后再试（如为校园网，可稍候或换网络）',
      });
    }
  }

  // 关键：查重 + 写入放在同一事务里，避免并发双击投出两票
  let result;
  try {
    db.exec('BEGIN IMMEDIATE');
    const state = voteState(session.voterKey);
    if (state.hasVoted) {
      db.exec('ROLLBACK');
      result = { ok: false, status: 409, code: 'ALREADY_VOTED', nextVoteAt: state.nextVoteAt };
    } else {
      const votedAt = addVote({
        voterKey: session.voterKey,
        identityType: session.identityType,
        openid: session.openid,
        player,
        ip,
        ua,
      });
      db.exec('COMMIT');
      result = { ok: true, status: 200, votedAt, nextVoteAt: nextAllowedAt({ created_at: votedAt }) };
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('[vote] 写入失败', err);
    return sendJson(res, 500, { ok: false, code: 'SERVER_ERROR', message: '服务器繁忙，请稍后重试' });
  }

  if (!result.ok) {
    return sendJson(res, result.status, {
      ok: false,
      code: result.code,
      message: '今日已完成投票，明天可再次投票',
      nextVoteAt: result.nextVoteAt,
    });
  }

  const payload = {
    ok: true,
    message: '投票成功！今日已完成投票，明天可再次投票',
    votedAt: result.votedAt,
    nextVoteAt: result.nextVoteAt,
    playerNo: player.no,
  };
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(200, headers);
  res.end(JSON.stringify(payload));
}

async function handleWxCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const to = url.searchParams.get('to') || '/';

  if (!config.wx.enabled) return redirect(res, '/');
  if (!code) return redirect(res, '/?wx=noop');
  if (!checkState(state)) {
    console.warn('[wx] state 校验失败，可能存在伪造回调');
    return redirect(res, '/?wx=badstate');
  }

  try {
    const { openid } = await exchangeCodeForOpenId(code);
    const token = sign({ k: `wx:${openid}`, t: 'wechat', o: openid, ts: Date.now() });
    redirect(res, safePath(to), [cookie(config.cookieName, token, { req, maxAge: config.cookieMaxAgeSec })]);
  } catch (err) {
    console.error('[wx] 换取 openid 失败：', err.message);
    redirect(res, '/?wx=error');
  }
}

function safePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return '/';
  return p;
}

// ---------------------------------------------------------------- 登录限速（防暴力破解）
const loginAttempts = new Map();
function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= 8;
}
function noteLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  rec.count += 1;
  loginAttempts.set(ip, rec);
}

function loginPage(error = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>后台登录 · 投票管理</title>
<style>
  :root{--ink:#1d2433;--brand:#1f3b73}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:var(--ink);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  .card{width:min(92vw,360px);background:#fff;border-radius:16px;padding:28px 24px;
        box-shadow:0 10px 40px rgba(20,30,60,.10);border:1px solid #e8eaf0}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{margin:0 0 20px;color:#7a8194;font-size:13px}
  label{display:block;font-size:13px;color:#5b6273;margin-bottom:6px}
  input{width:100%;padding:11px 12px;border:1px solid #d6dae3;border-radius:10px;font-size:15px;outline:none}
  input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(31,59,115,.12)}
  button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:10px;background:var(--brand);
         color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .err{margin-top:12px;font-size:13px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;
       padding:8px 10px;border-radius:8px}
</style></head><body>
<form class="card" method="post" action="/admin/login">
  <h1>投票后台</h1>
  <p class="sub">${config.event.shortName} · 线上投票</p>
  <label for="pwd">管理密码</label>
  <input id="pwd" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">进入后台</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form></body></html>`;
}

function handleAdminLoginGet(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(loginPage());
}

async function handleAdminLoginPost(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) {
    res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(loginPage('尝试次数过多，请 10 分钟后再试'));
  }
  let form = '';
  for await (const chunk of req) {
    form += chunk;
    if (form.length > 4096) break;
  }
  const params = new URLSearchParams(form);
  const password = params.get('password') || '';
  if (!safeEqual(password, config.adminPassword)) {
    noteLoginFail(ip);
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(loginPage('密码不正确'));
  }
  const token = sign({ role: 'admin', ts: Date.now(), ip });
  redirect(res, '/admin', [cookie(config.adminCookieName, token, { req, maxAge: config.adminSessionSec })]);
}

function adminData() {
  const rows = countsByPlayer();
  const total = rows.reduce((s, r) => s + r.votes, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.votes), 0);
  return {
    event: config.event,
    deadline: { ms: config.deadlineMs, label: config.deadlineLabel, closed: Date.now() > config.deadlineMs },
    windowMode: config.windowMode,
    wxEnabled: config.wx.enabled,
    overview: { ...overview(), totalPlayers: rows.length },
    players: rows.map((r) => ({
      id: r.id,
      no: r.no,
      name: r.name,
      image: r.image,
      votes: r.votes,
      share: total ? +(r.votes / total * 100).toFixed(1) : 0,
      bar: max ? Math.round(r.votes / max * 100) : 0,
    })),
    recent: recentVotes(200).map((v) => ({
      id: v.id,
      time: formatTime(v.created_at),
      no: v.player_no,
      playerId: v.player_id,
      type: v.identity_type,
      openid: maskOpenId(v.openid),
      voterKey: v.voter_key.startsWith('ck:') ? 'ck:' + v.voter_key.slice(3, 9) + '…' : 'wx:…',
      ip: v.ip,
      ua: (v.ua || '').slice(0, 80),
    })),
    suspicious: suspiciousIps(5),
    serverNow: Date.now(),
  };
}

function handleAdminExport(res, url) {
  const type = url.searchParams.get('type') || 'counts';
  let csv;
  let filename;
  if (type === 'votes') {
    const rows = allVotesForCsv().map((v) => [
      v.id,
      formatTime(v.created_at),
      v.player_no,
      playerMap.get(v.player_id)?.name || '',
      v.player_id,
      v.identity_type === 'wechat' ? '微信 openid' : 'Cookie 设备',
      v.openid || '',
      v.voter_key,
      v.ip || '',
      v.ua || '',
    ]);
    csv = toCsv(['记录ID', '投票时间(北京时间)', '选手序号', '选手姓名', '选手ID', '身份类型', 'openid', '身份标识', 'IP', 'User-Agent'], rows);
    filename = `投票明细_${new Date().toISOString().slice(0, 10)}.csv`;
  } else {
    const rows = countsByPlayer().map((p) => [p.no, p.name || '', p.id, p.votes]);
    const total = rows.reduce((s, r) => s + Number(r[3]), 0);
    rows.push(['', '合计', '', total]);
    csv = toCsv(['序号', '姓名', '选手ID', '票数'], rows);
    filename = `选手票数_${new Date().toISOString().slice(0, 10)}.csv`;
  }
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
  });
  res.end(csv);
}

// ---------------------------------------------------------------- 页面
function serveIndex(req, res) {
  const ua = req.headers['user-agent'] || '';
  const session = readSession(req);
  // 微信内、已配置公众号、还没拿到 openid → 静默授权后回到首页
  if (config.wx.enabled && isWeChatUA(ua) && !session) {
    return redirect(res, buildAuthUrl(makeState(), '/'));
  }
  serveFile(req, res, path.join(config.publicDir, 'index.html'));
}

function serveAdminPage(req, res) {
  if (!isAdmin(req)) return redirect(res, '/admin/login');
  serveFile(req, res, path.join(config.publicDir, 'admin.html'));
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const abs = path.resolve(config.publicDir, rel);
  if (!abs.startsWith(config.publicDir + path.sep)) return sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return notFound(res);
  const cache = /\.(svg|png|jpg|jpeg|webp|ico|woff2)$/i.test(abs) ? 3600 : 0;
  return serveFile(req, res, abs, cache);
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:sans-serif;padding:40px">页面不存在</body>');
}

// ---------------------------------------------------------------- 服务器
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'SAMEORIGIN');

  try {
    if (p === '/healthz') return sendText(res, 200, 'ok');

    if (p === '/api/config' && req.method === 'GET') return handleConfig(req, res);
    if (p === '/api/vote' && req.method === 'POST') return await handleVote(req, res);
    if (p === '/api/me' && req.method === 'GET') {
      const s = readSession(req);
      const st = voteState(s?.voterKey);
      return sendJson(res, 200, {
        identityType: s?.identityType || null,
        hasVoted: st.hasVoted,
        nextVoteAt: st.nextVoteAt,
        closed: Date.now() > config.deadlineMs,
        serverNow: Date.now(),
      });
    }

    if (p === '/wx/callback' && req.method === 'GET') return await handleWxCallback(req, res, url);

    if (p === '/admin/login' && req.method === 'GET') return handleAdminLoginGet(res);
    if (p === '/admin/login' && req.method === 'POST') return await handleAdminLoginPost(req, res);
    if (p === '/admin/logout') {
      return redirect(res, '/admin/login', [cookie(config.adminCookieName, '', { req, maxAge: 0 })]);
    }
    if (p === '/admin' || p === '/admin/') return serveAdminPage(req, res);
    if (p === '/admin/data.json' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
      return sendJson(res, 200, adminData());
    }
    if (p === '/admin/export.csv' && req.method === 'GET') {
      if (!isAdmin(req)) return sendText(res, 401, '请先登录后台');
      return handleAdminExport(res, url);
    }

    if (p === '/' || p === '/index.html') return serveIndex(req, res);

    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[server] 未捕获异常：', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'SERVER_ERROR' });
    else res.end();
  }
});

server.listen(config.port, () => {
  const mode = config.wx.enabled ? '微信 openid + 无法授权时回退 Cookie' : 'Cookie（未配置公众号）';
  console.log(`\n  校园投票已启动：http://localhost:${config.port}`);
  console.log(`  识别方式：${mode}`);
  console.log(`  投票窗口：${config.windowMode === 'rolling' ? '滚动 24 小时' : '自然日（北京时间）'}`);
  console.log(`  截止时间：${new Date(config.deadlineMs).toISOString()}（${config.deadlineLabel}）${config.deadlineAuto ? `  ← 未设置 VOTE_DEADLINE，按最近的 ${config.deadlineLabel} 自动计算` : ''}`);
  console.log(`  参赛选手：${players.length} 位　　数据库：${config.dbPath}`);
  if (config.adminPassword === 'admin1234') {
    console.log('  ⚠ 正在使用默认后台密码 admin1234，上线前请设置 ADMIN_PASSWORD\n');
  }
});

process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，正在关闭…');
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
});
