// 生成 6 张示例作品图（SVG 占位图），正式使用时替换为真实图片即可
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img');
fs.mkdirSync(dir, { recursive: true });

const palettes = [
  ['#1f3b73', '#3d6ab5', '#0f2145'],
  ['#2c5f6b', '#4f9aa8', '#163238'],
  ['#5b3a6e', '#8f6aa8', '#2c1b36'],
  ['#7a4a2b', '#b98a5c', '#3d2415'],
  ['#26543b', '#4f9a72', '#122a1d'],
  ['#6b2f45', '#a85f7b', '#331620'],
];

const svg = (i, [c1, c2, c3]) => {
  const no = String(i + 1).padStart(2, '0');
  const stars = Array.from({ length: 26 }, (_, k) => {
    const x = ((k * 97 + i * 53) % 560) + 20;
    const y = ((k * 71 + i * 37) % 320) + 20;
    const r = ((k % 3) + 1) * 0.7;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${0.18 + (k % 4) * 0.08}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450" width="600" height="450" role="img" aria-label="示例作品图 ${no}">
  <defs>
    <linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c1}"/>
    </linearGradient>
    <radialGradient id="glow${i}" cx="0.78" cy="0.22" r="0.62">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="450" fill="url(#g${i})"/>
  <rect width="600" height="450" fill="url(#glow${i})"/>
  ${stars}
  <g opacity="0.9">
    <circle cx="470" cy="330" r="86" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1.5"/>
    <circle cx="470" cy="330" r="52" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1.5"/>
    <circle cx="470" cy="330" r="20" fill="#ffffff" fill-opacity="0.12"/>
    <line x1="470" y1="330" x2="556" y2="244" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5"/>
  </g>
  <text x="46" y="196" font-family="Georgia, 'Times New Roman', serif" font-size="150" font-weight="700"
        fill="#ffffff" fill-opacity="0.94">${no}</text>
  <text x="50" y="246" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="24"
        fill="#ffffff" fill-opacity="0.88" letter-spacing="6">示例作品图</text>
  <text x="50" y="282" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="15"
        fill="#ffffff" fill-opacity="0.62">请替换 public/img/ 下的同名图片</text>
  <rect x="0" y="404" width="600" height="46" fill="${c3}" fill-opacity="0.55"/>
  <text x="50" y="433" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="14"
        fill="#ffffff" fill-opacity="0.72">武汉大学红色手工创作大赛 · 线上作品投票</text>
</svg>
`;
};

palettes.forEach((p, i) => {
  const file = path.join(dir, `player-${i + 1}.svg`);
  fs.writeFileSync(file, svg(i, p), 'utf8');
  console.log('写入', file);
});
