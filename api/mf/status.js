const { getMfTokens, upsertMfTokens } = require("../../lib/mf/supabaseAdmin");
const { getOffice, refreshAccessToken } = require("../../lib/mf/mfClient");

module.exports = async function handler(req, res) {
  try {
    const tokens = await getMfTokens();
    if (!tokens || !tokens.refresh_token) {
      res.status(200).json({ connected: false });
      return;
    }

    let accessToken = tokens.access_token;
    const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
    if (expiresAt - Date.now() <= 2 * 60 * 1000) {
      try {
        const refreshed = await refreshAccessToken(tokens.refresh_token);
        accessToken = refreshed.access_token;
        await upsertMfTokens({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || tokens.refresh_token,
          expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
        });
      } catch (e) {
        res.status(200).json({ connected: true, officeName: tokens.office_name || null, apiError: `token refresh failed: ${e.message || e}` });
        return;
      }
    }

    let officeName = tokens.office_name || null;
    let apiError = null;
    try {
      const office = await getOffice(accessToken);
      officeName = office.name || null;
      if (officeName) await upsertMfTokens({ office_name: officeName, office_id: office.id || null });
    } catch (e) {
      apiError = e.message || String(e);
    }

    res.status(200).json({
      connected: true,
      officeName,
      connectedAt: tokens.connected_at || null,
      apiError,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
