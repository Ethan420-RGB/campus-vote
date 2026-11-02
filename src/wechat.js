// 微信公众号网页授权（snsapi_base）：只拿 openid，不弹授权框，适合“静默识别用户”。
import { config } from './config.js';

export function isWeChatUA(ua = '') {
  return /MicroMessenger/i.test(ua);
}

// 跳转地址：微信要求 redirect_uri 的域名已在公众号后台“网页授权域名”里登记
export function buildAuthUrl(state, target = '/') {
  const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
  url.searchParams.set('appid', config.wx.appId);
  url.searchParams.set('redirect_uri', `${config.baseUrl}/wx/callback?to=${encodeURIComponent(target)}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'snsapi_base');
  url.searchParams.set('state', state);
  return url.toString() + '#wechat_redirect';
}

// 用 code 换取 openid
export async function exchangeCodeForOpenId(code) {
  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  url.searchParams.set('appid', config.wx.appId);
  url.searchParams.set('secret', config.wx.appSecret);
  url.searchParams.set('code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    if (!res.ok || data.errcode) {
      throw new Error(`微信接口返回错误：${data.errcode || res.status} ${data.errmsg || ''}`);
    }
    if (!data.openid) throw new Error('微信接口未返回 openid');
    return { openid: data.openid, unionid: data.unionid || null };
  } finally {
    clearTimeout(timer);
  }
}
