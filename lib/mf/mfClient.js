/*
 * Money Forward クラウド請求書 API クライアント(OAuth 2.0)。
 * quotes/billings一覧のパラメータ・レスポンス形式は、公式APIクライアント実装
 * (https://github.com/wywy-llc/mf-invoice-api の src/service/*.ts, src/@types/*.d.ts)で確認済み。
 */

const AUTH_BASE = "https://api.biz.moneyforward.com";
const API_BASE = "https://invoice.moneyforward.com/api/v3";
const AUTHORIZE_URL = `${AUTH_BASE}/authorize`;
const TOKEN_URL = `${AUTH_BASE}/token`;
/* 公式クライアント実装(mf-invoice-api)は data.write + data.read の両方を要求している。
   data.read単体だとbillings/quotes一覧が404になる事象を確認したため、こちらに合わせる。
   このアプリはAPI経由での書き込みは行わないが、要求スコープとしては両方必要な模様。 */
const SCOPE = "mfc/invoice/data.write mfc/invoice/data.read";

function authHeader() {
  const id = process.env.MF_CLIENT_ID;
  const secret = process.env.MF_CLIENT_SECRET;
  if (!id || !secret) throw new Error("MF_CLIENT_ID / MF_CLIENT_SECRET is not set");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

function buildAuthorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: process.env.MF_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`MF token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`MF token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/* レート制限(秒3回)対策の簡易リトライ付きGET */
async function mfGet(accessToken, path, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`MF API ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error(`MF API ${path} failed after ${retries} retries (rate limited)`);
}

async function getOffice(accessToken) {
  return mfGet(accessToken, "/office");
}

/*
 * quotes/billings 一覧取得。from/to(期間)は必須パラメータ。
 * range_key=updated_at にすることで、過去に作成済みの請求書でも「入金確認による更新」を
 * 直近の期間内の変更として拾えるようにしている(billing_date基準だと古い請求書の入金確認を見逃すため)。
 */
async function listRecent(accessToken, resource, { days = 60, maxPages = 5, perPage = 100 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    /* 公式クライアント実装と同じ並び・q(空文字でも必須)を含める形に合わせている */
    const reqPath =
      `/${resource}?page=${page}&per_page=${perPage}&range_key=updated_at` +
      `&from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(to))}&q=`;
    const json = await mfGet(accessToken, reqPath);
    const pageItems = json.data || [];
    items.push(...pageItems);
    const pagination = json.pagination || {};
    if (!pagination.total_pages || page >= pagination.total_pages || !pageItems.length) break;
  }
  return items;
}

module.exports = {
  SCOPE,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getOffice,
  listRecent,
};
