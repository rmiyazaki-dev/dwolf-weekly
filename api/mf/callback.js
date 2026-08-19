const { exchangeCodeForToken, getOffice } = require("../../lib/mf/mfClient");
const { upsertMfTokens } = require("../../lib/mf/supabaseAdmin");

function redirectUri(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}/api/mf/callback`;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query || {};
  if (error) {
    res.status(400).send(`Money Forward連携エラー: ${error}`);
    return;
  }
  const cookies = parseCookies(req);
  if (!code || !state || state !== cookies.mf_oauth_state) {
    res.status(400).send("不正なリクエストです(stateの検証に失敗)。設定タブから再度お試しください。");
    return;
  }
  try {
    const token = await exchangeCodeForToken(code, redirectUri(req));
    let officeName = null;
    let officeId = null;
    try {
      const office = await getOffice(token.access_token);
      officeName = office.name || office.office_name || null;
      officeId = office.id || null;
    } catch (_) {
      /* 事業者名の取得に失敗しても連携自体は継続 */
    }
    await upsertMfTokens({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
      office_id: officeId,
      office_name: officeName,
      connected_at: new Date().toISOString(),
    });
    res.setHeader("Set-Cookie", "mf_oauth_state=; Path=/; Max-Age=0");
    res.writeHead(302, { Location: "/#settings" });
    res.end();
  } catch (e) {
    res.status(500).send(`連携に失敗しました: ${String(e.message || e)}`);
  }
};
