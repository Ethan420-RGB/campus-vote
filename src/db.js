// SQLite 存取层（使用 Node 内置 node:sqlite，无需任何第三方依赖 / 无需编译）
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

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
    voter_key     TEXT    NOT NULL,           -- wx:<openid> 或 ck:<uuid>
    identity_type TEXT    NOT NULL,           -- wechat | cookie
    openid        TEXT,                       -- 微信模式下的 openid（cookie 模式为空）
    player_id     TEXT    NOT NULL,
    player_no     INTEGER NOT NULL,
    ip            TEXT,
    ua            TEXT,
    created_at    INTEGER NOT NULL            -- 毫秒时间戳
  );

  CREATE INDEX IF NOT EXISTS idx_votes_voter_time ON votes (voter_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_votes_player     ON votes (player_id);
  CREATE INDEX IF NOT EXISTS idx_votes_ip_time    ON votes (ip, created_at DESC);
`);

const stmts = {
  lastByVoter: db.prepare(
    'SELECT id, player_id, created_at FROM votes WHERE voter_key = ? ORDER BY created_at DESC LIMIT 1'
  ),
  insert: db.prepare(`
    INSERT INTO votes (voter_key, identity_type, openid, player_id, player_no, ip, ua, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  countByPlayer: db.prepare('SELECT player_id, COUNT(*) AS n FROM votes GROUP BY player_id'),
  total: db.prepare('SELECT COUNT(*) AS n FROM votes'),
  distinctVoters: db.prepare('SELECT COUNT(DISTINCT voter_key) AS n FROM votes'),
  since: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE created_at >= ?'),
  ipSince: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE ip = ? AND created_at >= ?'),
  recent: db.prepare(`
    SELECT id, voter_key, identity_type, openid, player_id, player_no, ip, ua, created_at
    FROM votes ORDER BY created_at DESC LIMIT ?
  `),
  allForCsv: db.prepare(`
    SELECT id, created_at, player_no, player_id, identity_type, openid, voter_key, ip, ua
    FROM votes ORDER BY created_at ASC
  `),
  dupIp: db.prepare(`
    SELECT ip, COUNT(*) AS n, COUNT(DISTINCT voter_key) AS voters
    FROM votes WHERE ip IS NOT NULL AND ip <> ''
    GROUP BY ip HAVING n >= ? ORDER BY n DESC LIMIT 20
  `),
};

// ---------------------------------------------------------------- 选手数据
function readPlayers() {
  const raw = fs.readFileSync(config.playersPath, 'utf8');
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error('players.json 必须是非空数组');
  return list
    .map((p, i) => ({
      id: String(p.id ?? i + 1),
      no: Number(p.no ?? i + 1),
      name: String(p.name ?? '').slice(0, 40),
      // 卡片字段：序号、展示图片、200 字以内创作阐述
      image: String(p.image ?? `/img/player-${((i % 6) + 1)}.svg`),
      desc: String(p.desc ?? '').slice(0, 200),
    }))
    .sort((a, b) => a.no - b.no);
}

export const players = readPlayers();
export const playerMap = new Map(players.map((p) => [p.id, p]));

// ---------------------------------------------------------------- 投票读写
export function lastVoteOf(voterKey) {
  return stmts.lastByVoter.get(voterKey) || null;
}

export function addVote({ voterKey, identityType, openid, player, ip, ua }) {
  const now = Date.now();
  stmts.insert.run(
    voterKey,
    identityType,
    openid || null,
    player.id,
    player.no,
    ip || null,
    (ua || '').slice(0, 300),
    now
  );
  return now;
}

export function countsByPlayer() {
  const rows = stmts.countByPlayer.all();
  const map = new Map(rows.map((r) => [r.player_id, Number(r.n)]));
  return players.map((p) => ({ ...p, votes: map.get(p.id) || 0 }));
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
