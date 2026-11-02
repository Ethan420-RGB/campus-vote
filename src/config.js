// 全局配置：全部来自环境变量，缺省值可直接本地跑起来。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// 极简 .env 读取（不引入 dotenv；已存在的环境变量优先，方便 Render 覆盖）
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 会话密钥：优先环境变量；否则落盘到 data/.session-secret，重启后不会把所有人踢下线。
function resolveSessionSecret() {
  const fromEnv = env('SESSION_SECRET');
  if (fromEnv) return fromEnv;
  ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch { /* 首次运行 */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const port = Number(env('PORT', 8787));

// 截止时间：未显式配置时，自动取“最近的 11 月 24 日 23:59:59（北京时间）”，
// 这样默认值不会因为跨年而失效；正式活动建议用 VOTE_DEADLINE 写死。
const DEADLINE_MONTH = 10; // 0 起算：10 = 11 月
const DEADLINE_DAY = 24;
const DEADLINE_LABEL = '11 月 24 日 24:00';

function nextDeadline() {
  const BJ = 8 * 3600 * 1000;
  const nowBj = new Date(Date.now() + BJ);
  let year = nowBj.getUTCFullYear();
  let ts = Date.UTC(year, DEADLINE_MONTH, DEADLINE_DAY, 23, 59, 59) - BJ;
  if (ts <= Date.now()) {
    year += 1;
    ts = Date.UTC(year, DEADLINE_MONTH, DEADLINE_DAY, 23, 59, 59) - BJ;
  }
  return { ts, year };
}

const autoDeadline = nextDeadline();
const deadlineRaw = env('VOTE_DEADLINE');
const deadlineMs = deadlineRaw ? Date.parse(deadlineRaw) : autoDeadline.ts;

if (Number.isNaN(deadlineMs)) {
  throw new Error(`VOTE_DEADLINE 无法解析：${deadlineRaw}（示例：2026-11-24T23:59:59+08:00）`);
}

const windowMode = env('VOTE_WINDOW_MODE', 'rolling').toLowerCase() === 'calendar' ? 'calendar' : 'rolling';

export const config = {
  port,
  root: ROOT,
  dataDir: DATA_DIR,
  publicDir: PUBLIC_DIR,

  // 对外访问地址，用于微信网页授权的 redirect_uri（必须是 https + 已配置的网页授权域名）
  baseUrl: env('PUBLIC_BASE_URL', `http://localhost:${port}`).replace(/\/+$/, ''),

  dbPath: env('DB_PATH', path.join(DATA_DIR, 'votes.db')),
  playersPath: env('PLAYERS_PATH', path.join(DATA_DIR, 'players.json')),

  // 截止时间：服务端为准，前端只做展示
  deadlineMs,
  deadlineAuto: !deadlineRaw,
  deadlineLabel: env('VOTE_DEADLINE_LABEL', DEADLINE_LABEL),
  closedText: env('VOTE_CLOSED_TEXT', `投票已于 ${DEADLINE_LABEL} 截止，现仅展示作品信息`),

  // 投票窗口：rolling = 距上次投票满 24 小时；calendar = 自然日（北京时间 00:00 重置）
  windowMode,
  windowMs: 24 * 60 * 60 * 1000,

  sessionSecret: resolveSessionSecret(),
  cookieName: 'cv_sid',
  adminCookieName: 'cv_admin',
  cookieMaxAgeSec: 180 * 24 * 3600,
  adminSessionSec: 8 * 3600,

  adminPassword: env('ADMIN_PASSWORD', 'admin1234'),

  // 微信网页授权（snsapi_base）；两项都配了才启用 openid 模式
  wx: {
    appId: env('WX_APPID'),
    appSecret: env('WX_SECRET'),
    get enabled() {
      return Boolean(this.appId && this.appSecret);
    },
  },

  // IP 软限流：只防脚本洪水，不做“一 IP 一票”的硬封禁（校园 NAT 会误伤）
  ipLimit: {
    windowMs: Number(env('IP_LIMIT_WINDOW_MIN', 10)) * 60 * 1000,
    max: Number(env('IP_LIMIT_MAX', 80)),
  },

  // 公开页是否显示实时票数（默认不显示，避免从众效应）
  showCounts: env('SHOW_COUNTS', 'false') === 'true',

  // 活动文案
  event: {
    year: env('EVENT_YEAR', '2026'),
    title: env('EVENT_TITLE', '“指尖传薪火，巧手绘初心”'),
    subtitle: env('EVENT_SUBTITLE', '武汉大学红色手工创作大赛 · 线上作品投票'),
    org: env('EVENT_ORG', '主办：共青团武汉大学哲学学院委员会'),
    org2: env('EVENT_ORG2', '协办：共青团武汉大学社会学院委员会 · 共青团武汉大学地球与空间科学学院委员会'),
    shortName: env('EVENT_SHORT', '武汉大学红色手工创作大赛'),
  },

  isProd: env('NODE_ENV', 'development') === 'production',
  trustProxy: env('TRUST_PROXY', 'true') !== 'false',
};

ensureDir(config.dataDir);
