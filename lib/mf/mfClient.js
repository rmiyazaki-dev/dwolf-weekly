/*
 * Money Forward クラウド請求書 API クライアント(OAuth 2.0)。
 * 認可URL/トークンURLは公式ドキュメントで確認済み。quotes/billings一覧のページングパラメータ名
 * (page/per_page)は実装時点で未確認のため、実データで挙動を見て mfClient.js 内だけを調整すること。
 */

const AUTH_BASE = "https://api.biz.moneyforward.com";
const API_BASE = "https://invoice.moneyforward.com/api/v3";
const AUTHORIZE_URL = `${AUTH_BASE}/authorize`;
const TOKEN_URL = `${AUTH_BASE}/token`;
const SCOPE = "mfc/invoice/data.read";

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

/* quotes/billings は1〜数ページ分だけ取得(全件同期ではなく直近分の差分検知が目的) */
async function listRecent(accessToken, resource, maxPages = 3, perPage = 50) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await mfGet(accessToken, `/${resource}?page=${page}&per_page=${perPage}`);
    const pageItems = json[resource] || json.data || (Array.isArray(json) ? json : []);
    if (!pageItems.length) break;
    items.push(...pageItems);
    if (pageItems.length < perPage) break;
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
