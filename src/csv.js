// CSV 生成（带 UTF-8 BOM，Excel/WPS 打开不乱码）
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
  // 统一按北京时间输出，便于评审与统计
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export function maskOpenId(openid) {
  if (!openid) return '';
  if (openid.length <= 10) return openid.slice(0, 3) + '***';
  return openid.slice(0, 6) + '……' + openid.slice(-4);
}
