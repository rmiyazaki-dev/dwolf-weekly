const mf = require("../../lib/mf/mfClient");
const { normalizePartnerName, extractQuoteFields, extractBillingFields, isPaid, amountsClose } = require("../../lib/mf/fieldMap");
const admin = require("../../lib/mf/supabaseAdmin");
const db = require("../../lib/mf/supabaseAnon");

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || "";
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("manual") === "1") return true; // 社内限定ツール前提の軽量トリガー
  return false;
}

function findCandidates(activeCases, partnerName, amount, linkedField) {
  const normTarget = normalizePartnerName(partnerName);
  if (!normTarget) return [];
  return activeCases.filter(
    (c) => !c[linkedField] && normalizePartnerName(c.customerName) === normTarget && amountsClose(c.quoteAmount || c.orderAmount, amount)
  );
}

async function ensureAccessToken() {
  const tokens = await admin.getMfTokens();
  if (!tokens || !tokens.refresh_token) return null;
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 2 * 60 * 1000) return tokens.access_token;
  const refreshed = await mf.refreshAccessToken(tokens.refresh_token);
  await admin.upsertMfTokens({
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
  });
  return refreshed.access_token;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const summary = { quotesSeen: 0, quotesLinked: 0, quotesQueued: 0, billingsSeen: 0, billingsUpdated: 0, billingsQueued: 0 };
  try {
    const accessToken = await ensureAccessToken();
    if (!accessToken) {
      res.status(400).json({ error: "not_connected" });
      return;
    }

    const [rawQuotes, rawBillings] = await Promise.all([
      mf.listRecent(accessToken, "quotes"),
      mf.listRecent(accessToken, "billings"),
    ]);
    let activeCases = await db.getActiveCases();

    for (const raw of rawQuotes) {
      summary.quotesSeen++;
      const q = extractQuoteFields(raw);
      const existing = await db.findCaseByMfId("mfQuoteId", q.mfId);
      if (existing) continue;
      const candidates = findCandidates(activeCases, q.partnerName, q.amount, "mfQuoteId");
      if (candidates.length === 1) {
        const c = candidates[0];
        const merged = await db.updateCaseData(c.id, { mfQuoteId: q.mfId, mfQuoteNumber: q.mfNumber, mfLinkedAt: new Date().toISOString() });
        activeCases = activeCases.map((x) => (x.id === c.id ? { id: c.id, ...merged } : x));
        await db.insertCaseHistory(c.id, "MF連携(自動)", "MF見積 自動突合", `${q.mfNumber || q.mfId}(${q.partnerName || ""})`);
        await db.insertAuditLog("MF連携(自動)", "MF見積 自動突合", `${c.name}:${q.mfNumber || q.mfId}`);
        summary.quotesLinked++;
      } else {
        await db.queueReviewItem({
          type: "quote",
          mf_id: q.mfId,
          mf_number: q.mfNumber,
          partner_name: q.partnerName,
          amount: q.amount,
          issue_date: q.issueDate,
          raw,
        });
        summary.quotesQueued++;
      }
    }

    for (const raw of rawBillings) {
      summary.billingsSeen++;
      const b = extractBillingFields(raw);
      let target = null;
      if (b.relatedQuoteId) target = await db.findCaseByMfId("mfQuoteId", b.relatedQuoteId);
      if (!target) target = await db.findCaseByMfId("mfBillingId", b.mfId);
      if (!target) {
        const candidates = findCandidates(activeCases, b.partnerName, b.amount, "mfBillingId");
        if (candidates.length === 1) target = candidates[0];
      }
      if (!target) {
        await db.queueReviewItem({
          type: "billing",
          mf_id: b.mfId,
          mf_number: b.mfNumber,
          partner_name: b.partnerName,
          amount: b.amount,
          issue_date: b.issueDate,
          related_quote_mf_id: b.relatedQuoteId,
          raw,
        });
        summary.billingsQueued++;
        continue;
      }
      const patch = {};
      if (!target.mfBillingId) {
        patch.mfBillingId = b.mfId;
        patch.mfLinkedAt = new Date().toISOString();
      }
      const current = target.billingStatus || "未請求";
      let action = null;
      if (isPaid(b.paymentStatus) && current !== "入金済") {
        patch.billingStatus = "入金済";
        action = "MF入金確認";
      } else if (!isPaid(b.paymentStatus) && current === "未請求") {
        patch.billingStatus = "請求済";
        action = "MF請求書検知";
      }
      if (Object.keys(patch).length) {
        const merged = await db.updateCaseData(target.id, patch);
        activeCases = activeCases.map((x) => (x.id === target.id ? { id: target.id, ...merged } : x));
        if (action) {
          await db.insertCaseHistory(target.id, "MF連携(自動)", action, `${b.mfNumber || b.mfId}`);
          await db.insertAuditLog("MF連携(自動)", action, `${target.name}:${b.mfNumber || b.mfId}`);
        }
        summary.billingsUpdated++;
      }
    }

    await db.kvSet("mf_sync_state", { lastSyncAt: new Date().toISOString(), ...summary });
    res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), ...summary });
  }
};
