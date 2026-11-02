// 造一批演示数据，方便本地预览后台面板（正式使用前请删掉 data/votes.db 重新开始）
import { db, players } from '../src/db.js';

const force = process.argv.includes('--force');
const existing = db.prepare('SELECT COUNT(*) AS n FROM votes').get().n;
if (existing > 0 && !force) {
  console.log(`已有 ${existing} 条投票记录，未做任何修改。如需继续造数据请加 --force`);
  process.exit(0);
}
if (force) db.exec('DELETE FROM votes');

const insert = db.prepare(`
  INSERT INTO votes (voter_key, identity_type, openid, player_id, player_no, ip, ua, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const weights = [1.0, 0.82, 0.7, 0.55, 0.42, 0.3];
const total = 120;
const now = Date.now();
let made = 0;

for (let i = 0; i < total; i++) {
  // 按权重挑选手，制造有差异的票数分布
  const r = Math.random();
  let acc = 0;
  let idx = 0;
  const sum = weights.reduce((s, w) => s + w, 0);
  for (let k = 0; k < weights.length; k++) {
    acc += weights[k] / sum;
    if (r <= acc) { idx = k; break; }
  }
  const player = players[idx % players.length];
  const isWx = Math.random() < 0.72;
  const voterKey = isWx ? `wx:demo${String(i).padStart(6, '0')}` : `ck:${Math.random().toString(16).slice(2, 14)}`;
  const openid = isWx ? `oDemo${String(i).padStart(10, '0')}x9f` : null;
  const ip = `10.${20 + (i % 3)}.${(i * 7) % 255}.${(i * 13) % 255}`;
  const ua = isWx
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) MicroMessenger/8.0.49'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';
  const createdAt = now - Math.floor(Math.random() * 3 * 24 * 3600 * 1000);
  insert.run(voterKey, isWx ? 'wechat' : 'cookie', openid, player.id, player.no, ip, ua, createdAt);
  made++;
}

console.log(`已生成 ${made} 条演示投票记录（--force 可清空重建）`);
db.close();
