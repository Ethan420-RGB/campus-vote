// CSV 生成（带 UTF-8 BOM，Excel/WPS 打开不乱码）
import { beijingDateTime } from './config.js';

export function toCsv(header, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function formatTime(ms) {
  // 统一按北京时间（Asia/Shanghai）输出，与服务器所在时区无关
  return beijingDateTime(ms);
}

export function maskOpenId(openid) {
  if (!openid) return '';
  if (openid.length <= 10) return openid.slice(0, 3) + '***';
  return openid.slice(0, 6) + '……' + openid.slice(-4);
}
