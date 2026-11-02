// SQLite 存取层（使用 Node 内置 node:sqlite，无需任何第三方依赖 / 无需编译）
import fs from 'node:fs';
import path from 'node:path';
import { config, beijingDateKey, beijingDateTime } from './config.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    '\n[启动失败] 当前 Node 版本不支持内置 node:sqlite。\n' +
      '请使用 Node >= 22.5（22.x 需加 --experimental-sqlite），推荐 Node 24。\n' +
      `当前版本：${process.version}\n`
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS votes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    voter_key     TEXT    NOT NULL,           -- ck:<uuid>（Cookie 识别）或 wx:<openid>
    identity_type TEXT    NOT NULL,           -- cookie | wechat
    openid        TEXT,                       -- 微信模式下的 openid（Cookie 模式为空）
    player_id     TEXT    NOT NULL,
    player_no     INTEGER NOT NULL,
    ip            TEXT,
    ua            TEXT,
    created_at    INTEGER NOT NULL,           -- 毫秒时间戳（用于排序/统计）
    bj_date       TEXT,                       -- 北京时间自然日 'YYYY-MM-DD'，一天一票的判定依据
    bj_time       TEXT                        -- 完整北京时间 'YYYY-MM-DD HH:mm:ss'（便于直接核对，无时区歧义）
  );

  CREATE INDEX IF NOT EXISTS idx_votes_voter_time ON votes (voter_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_votes_player     ON votes (player_id);
  CREATE INDEX IF NOT EXISTS idx_votes_ip_time    ON votes (ip, created_at DESC);
`);

// ---------------------------------------------------------------- 老库迁移
// 之前只有 created_at（UTC 毫秒），这里补上两个北京时间字段，并用 created_at 回填历史数据。
// 全部用 ALTER TABLE ADD COLUMN，幂等，可重复执行；不会动已有记录。
function ensureColumn(name, ddl) {
  const cols = db.prepare('PRAGMA table_info(votes)').all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE votes ADD COLUMN ${ddl}`);
}

ensureColumn('bj_date', "bj_date TEXT");
ensureColumn('bj_time', "bj_time TEXT");
db.exec('CREATE INDEX IF NOT EXISTS idx_votes_voter_date ON votes (voter_key, bj_date)');

(function backfillBeijingFields() {
  const rows = db.prepare('SELECT id, created_at FROM votes WHERE bj_date IS NULL OR bj_time IS NULL').all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE votes SET bj_date = ?, bj_time = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      upd.run(beijingDateKey(r.created_at), beijingDateTime(r.created_at), r.id);
    }
    db.exec('COMMIT');
    console.log(`[db] 已为 ${rows.length} 条历史投票补齐北京时间字段`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[db] 回填北京时间字段失败：', err.message);
  }
})();

const stmts = {
  lastByVoter: db.prepare(
    'SELECT id, player_id, created_at, bj_date, bj_time FROM votes WHERE voter_key = ? ORDER BY created_at DESC LIMIT 1'
  ),
  // 自然日判定的核心查询：同一 voter_key + 同一北京自然日，最多一条
  onDate: db.prepare(
    'SELECT id, player_id, created_at, bj_time FROM votes WHERE voter_key = ? AND bj_date = ? LIMIT 1'
  ),
  insert: db.prepare(`
    INSERT INTO votes (voter_key, identity_type, openid, player_id, player_no, ip, ua, created_at, bj_date, bj_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  countByPlayer: db.prepare('SELECT player_id, COUNT(*) AS n FROM votes GROUP BY player_id'),
  total: db.prepare('SELECT COUNT(*) AS n FROM votes'),
  distinctVoters: db.prepare('SELECT COUNT(DISTINCT voter_key) AS n FROM votes'),
  since: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE created_at >= ?'),
  ipSince: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE ip = ? AND created_at >= ?'),
  recent: db.prepare(`
    SELECT id, voter_key, identity_type, openid, player_id, player_no, ip, ua, created_at, bj_date, bj_time
    FROM votes ORDER BY created_at DESC LIMIT ?
  `),
  allForCsv: db.prepare(`
    SELECT id, created_at, bj_date, bj_time, player_no, player_id, identity_type, openid, voter_key, ip, ua
    FROM votes ORDER BY created_at ASC
  `),
  dupIp: db.prepare(`
    SELECT ip, COUNT(*) AS n, COUNT(DISTINCT voter_key) AS voters
    FROM votes WHERE ip IS NOT NULL AND ip <> ''
    GROUP BY ip HAVING n >= ? ORDER BY n DESC LIMIT 20
  `),
};

// ---------------------------------------------------------------- 选手数据（支持热更新）
// 每次读取都会比较 players.json 的 mtime：改完文件刷新页面即可生效，不用重启进程。
// 如果新文件写坏了（JSON 语法错），会继续沿用上一版，不会把线上页面搞崩。
let playerCache = { mtime: 0, size: -1, data: null };

function normalizePlayers(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('players.json 必须是非空数组');
  const seen = new Set();
  const out = list.map((p, i) => {
    const id = String(p.id ?? i + 1);
    if (seen.has(id)) console.warn(`[players] 发现重复 id：${id}，请尽快修正`);
    seen.add(id);
    return {
      id,
      no: Number(p.no ?? i + 1),
      name: String(p.name ?? '').slice(0, 40),
      // 卡片字段：序号、展示图片、200 字以内创作阐述
      image: String(p.image ?? `/img/player-${((i % 6) + 1)}.svg`),
      desc: String(p.desc ?? '').slice(0, 200),
    };
  });
  return out.sort((a, b) => a.no - b.no);
}

function loadPlayers() {
  let stat;
  try {
    stat = fs.statSync(config.playersPath);
  } catch (err) {
    if (playerCache.data) {
      console.warn('[players] 读不到 players.json，继续使用上一版：', err.message);
      return playerCache.data;
    }
    throw err;
  }

  if (playerCache.data && stat.mtimeMs === playerCache.mtime && stat.size === playerCache.size) {
    return playerCache.data;
  }

  try {
    const raw = fs.readFileSync(config.playersPath, 'utf8');
    const data = normalizePlayers(JSON.parse(raw));
    playerCache = { mtime: stat.mtimeMs, size: stat.size, data };
    console.log(`[players] 已加载 ${data.length} 个作品（支持热更新）`);
    return data;
  } catch (err) {
    console.error('[players] players.json 解析失败，继续使用上一版：', err.message);
    if (playerCache.data) return playerCache.data;
    throw err;
  }
}

/** 当前作品列表（每次调用都会检查文件是否变化） */
export function getPlayers() {
  return loadPlayers();
}

/** id -> 作品 的映射，投票时用它校验 */
export function getPlayerMap() {
  return new Map(getPlayers().map((p) => [p.id, p]));
}

// ---------------------------------------------------------------- 投票读写
export function lastVoteOf(voterKey) {
  return stmts.lastByVoter.get(voterKey) || null;
}

/** 该身份在某个北京自然日（'YYYY-MM-DD'）是否已经投过票 */
export function voteOnDate(voterKey, bjDate) {
  if (!voterKey || !bjDate) return null;
  return stmts.onDate.get(voterKey, bjDate) || null;
}

/**
 * 写入一票，同时落库“完整北京时间”。
 * @returns {{createdAt:number, bjDate:string, bjTime:string}}
 */
export function addVote({ voterKey, identityType, openid, player, ip, ua }) {
  const now = Date.now();
  const bjDate = beijingDateKey(now);
  const bjTime = beijingDateTime(now);
  stmts.insert.run(
    voterKey,
    identityType,
    openid || null,
    player.id,
    player.no,
    ip || null,
    (ua || '').slice(0, 300),
    now,
    bjDate,
    bjTime
  );
  return { createdAt: now, bjDate, bjTime };
}

export function countsByPlayer() {
  const rows = stmts.countByPlayer.all();
  const map = new Map(rows.map((r) => [r.player_id, Number(r.n)]));
  return getPlayers().map((p) => ({ ...p, votes: map.get(p.id) || 0 }));
}

export function overview() {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  return {
    totalVotes: Number(stmts.total.get().n),
    distinctVoters: Number(stmts.distinctVoters.get().n),
    votes24h: Number(stmts.since.get(dayAgo).n),
  };
}

export function votesFromIpSince(ip, sinceMs) {
  if (!ip) return 0;
  return Number(stmts.ipSince.get(ip, sinceMs).n);
}

export function recentVotes(limit = 200) {
  return stmts.recent.all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
}

export function allVotesForCsv() {
  return stmts.allForCsv.all();
}

export function suspiciousIps(minVotes = 5) {
  return stmts.dupIp.all(minVotes);
}
