const { getMfTokens } = require("../../lib/mf/supabaseAdmin");

module.exports = async function handler(req, res) {
  try {
    const tokens = await getMfTokens();
    if (!tokens || !tokens.refresh_token) {
      res.status(200).json({ connected: false });
      return;
    }
    res.status(200).json({
      connected: true,
      officeName: tokens.office_name || null,
      connectedAt: tokens.connected_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
