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

// ---------------------------------------------------------------- 北京时间工具
// 强制使用 Asia/Shanghai：所有"自然日"判断都走这里，避免服务器时区（UTC）造成
// 提前/延后解锁。北京时间自 1991 年起无夏令时，恒为 UTC+8。
export const TIME_ZONE = 'Asia/Shanghai';
export const TZ_OFFSET = '+08:00';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hourCycle: 'h23',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** 北京时间自然日键：'YYYY-MM-DD'（如 2026-11-24） */
export function beijingDateKey(ts = Date.now()) {
  return dateFmt.format(new Date(ts));
}

/** 北京时间时刻：'HH:mm:ss' */
export function beijingClock(ts = Date.now()) {
  return clockFmt.format(new Date(ts));
}

/** 完整北京时间：'YYYY-MM-DD HH:mm:ss' */
export function beijingDateTime(ts = Date.now()) {
  return `${beijingDateKey(ts)} ${beijingClock(ts)}`;
}

/** 该时刻所属北京自然日的 00:00:00（毫秒时间戳） */
export function beijingDayStart(ts = Date.now()) {
  return Date.parse(`${beijingDateKey(ts)}T00:00:00${TZ_OFFSET}`);
}

/** 下一个北京自然日 00:00:00（毫秒时间戳） */
export function nextBeijingMidnight(ts = Date.now()) {
  return beijingDayStart(ts) + 24 * 3600 * 1000;
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

// 投票限制：默认【北京时间自然日一天一票】。
// 兼容旧配置：显式设置 VOTE_WINDOW_MODE=rolling 才回到“滚动 24 小时”（不建议）。
const windowMode = env('VOTE_WINDOW_MODE', 'calendar').toLowerCase() === 'rolling' ? 'rolling' : 'calendar';

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

  // 投票窗口：calendar = 北京时间自然日（默认，每天 00:00 重置）；
  //           rolling  = 旧版“滚动 24 小时”，仅为兼容保留，不建议再使用
  windowMode,
  windowMs: 24 * 60 * 60 * 1000,
  timeZone: TIME_ZONE,

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
