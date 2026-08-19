const crypto = require("crypto");
const { buildAuthorizeUrl } = require("../../lib/mf/mfClient");

function redirectUri(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}/api/mf/callback`;
}

module.exports = async function handler(req, res) {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const url = buildAuthorizeUrl(redirectUri(req), state);
    res.setHeader(
      "Set-Cookie",
      `mf_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    );
    res.writeHead(302, { Location: url });
    res.end();
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
