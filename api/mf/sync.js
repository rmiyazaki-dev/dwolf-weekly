const mf = require("../../lib/mf/mfClient");
const { normalizePartnerName, extractQuoteFields, extractBillingFields, isPaid, amountsClose } = require("../../lib/mf/fieldMap");
const admin = require("../../lib/mf/supabaseAdmin");
const db = require("../../lib/mf/supabaseAnon");

function fmtYenLog(n) {
  const v = Number(n) || 0;
  return v ? `¥${v.toLocaleString("ja-JP")}` : "";
}

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

/*
 * 請求書は「既に見積が紐付いている・まだ請求書は紐付いていない・取引先名が一致する」案件を
 * 金額の一致に関わらず優先的に候補にする(見積→請求書で1つの案件にまとめるため。
 * MFのAPIには見積書と請求書を直接つなぐフィールドが無いため、この優先度で代替する)。
 */
function findQuoteLinkedCandidates(activeCases, partnerName) {
  const normTarget = normalizePartnerName(partnerName);
  if (!normTarget) return [];
  return activeCases.filter((c) => c.mfQuoteId && !c.mfBillingId && normalizePartnerName(c.customerName) === normTarget);
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
    ]).catch((e) => {
      throw new Error(`quotes/billings fetch failed: ${e.message || e}`);
    });
    let activeCases = await db.getActiveCases();

    for (const raw of rawQuotes) {
      summary.quotesSeen++;
      const q = extractQuoteFields(raw);
      const existing = await db.findCaseByMfId("mfQuoteId", q.mfId);
      if (existing) continue; // 全く同じ見積は処理済み

      /* 同じ取引先で既に見積が紐付いている案件が1件だけあれば、発行日が新しい方を優先して上書きする
         (見積の再発行・改訂に対応。金額の一致は問わない) */
      const normTarget = normalizePartnerName(q.partnerName);
      const quoteLinkedSamePartner = normTarget
        ? activeCases.filter((c) => c.mfQuoteId && normalizePartnerName(c.customerName) === normTarget)
        : [];
      let target = null;
      let isOverwrite = false;
      if (quoteLinkedSamePartner.length === 1) {
        const c = quoteLinkedSamePartner[0];
        if (!c.mfQuoteDate || String(q.issueDate || "") > String(c.mfQuoteDate)) {
          target = c;
          isOverwrite = true;
        } else {
          continue; // 既存の方が新しい見積なので、この見積は無視する
        }
      }
      if (!target) {
        const candidates = findCandidates(activeCases, q.partnerName, q.amount, "mfQuoteId");
        if (candidates.length === 1) target = candidates[0];
      }
      if (target) {
        const merged = await db.updateCaseData(target.id, {
          mfQuoteId: q.mfId,
          mfQuoteNumber: q.mfNumber,
          mfQuoteDate: q.issueDate || null,
          mfLinkedAt: new Date().toISOString(),
          quoteAmount: String(q.amount),
          status: "見積提出",
        });
        activeCases = activeCases.map((x) => (x.id === target.id ? { id: target.id, ...merged } : x));
        const action = isOverwrite ? "MF見積 更新(新しい見積で上書き)" : "MF見積 自動突合";
        await db.insertCaseHistory(target.id, "MF連携(自動)", action, `${q.mfNumber || q.mfId}(${q.partnerName || ""}・見積${fmtYenLog(q.amount)})`);
        await db.insertAuditLog("MF連携(自動)", action, `${target.name}:${q.mfNumber || q.mfId}`);
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
      let target = await db.findCaseByMfId("mfBillingId", b.mfId);
      if (!target) {
        const quoteLinked = findQuoteLinkedCandidates(activeCases, b.partnerName);
        if (quoteLinked.length === 1) target = quoteLinked[0];
      }
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
          raw,
        });
        summary.billingsQueued++;
        continue;
      }
      const patch = {};
      const firstLink = !target.mfBillingId;
      if (firstLink) {
        patch.mfBillingId = b.mfId;
        patch.mfLinkedAt = new Date().toISOString();
        patch.status = "請求書提出";
      }
      /* 売上(受注額)は請求書の金額(税込)を正として登録する。見積額とは別フィールドのまま両方保持する */
      if (String(target.orderAmount || "") !== String(b.amount)) patch.orderAmount = String(b.amount);
      /* 入金予定日は請求書のお支払期限を正として登録する */
      if (b.dueDate && String(target.paymentDate || "") !== String(b.dueDate)) patch.paymentDate = b.dueDate;
      const current = target.billingStatus || "未請求";
      let action = firstLink ? "MF請求書 自動突合" : null;
      if (isPaid(b.paymentStatus)) {
        if (current !== "入金済") {
          patch.billingStatus = "入金済";
          action = "MF入金確認";
        }
      } else if (current !== "請求済" && current !== "入金済") {
        patch.billingStatus = "請求済";
        action = action || "MF請求書検知";
      }
      if (Object.keys(patch).length) {
        const merged = await db.updateCaseData(target.id, patch);
        activeCases = activeCases.map((x) => (x.id === target.id ? { id: target.id, ...merged } : x));
        if (action) {
          await db.insertCaseHistory(target.id, "MF連携(自動)", action, `${b.mfNumber || b.mfId}(請求${fmtYenLog(b.amount)})`);
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
