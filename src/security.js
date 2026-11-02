// 极简签名/校验工具：Cookie 用 HMAC-SHA256 签名，防篡改。
import crypto from 'node:crypto';
import { config } from './config.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

// 简短的状态串，用于微信授权回调时防 CSRF（与 session cookie 无关，带过期）
export function makeState() {
  const payload = { n: randomId(8), t: Date.now() };
  return sign({ ...payload, s: 'wxstate' });
}

export function checkState(state) {
  const p = verify(state);
  if (!p || p.s !== 'wxstate') return false;
  return Date.now() - p.t < 10 * 60 * 1000;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// 对比密码时用固定长度比较，避免时序侧信道
export function safeEqual(a, b) {
  const ba = Buffer.from(sha256(a), 'hex');
  const bb = Buffer.from(sha256(b), 'hex');
  return crypto.timingSafeEqual(ba, bb);
}
