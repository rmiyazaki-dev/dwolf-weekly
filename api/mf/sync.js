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
 * 案件名がMFの件名(title)と完全一致する案件を最優先の候補にする。
 * 「請求書を先に新規案件として登録し、後から見積が来る」場合など、見積↔請求書どちらが
 * 先でも案件名(=作成時にMFの件名をそのまま使う)を軸に同じ案件へまとめられるようにする。
 */
function findTitleMatch(activeCases, title, linkedField) {
  const t = String(title || "").trim();
  if (!t) return [];
  return activeCases.filter((c) => !c[linkedField] && String(c.name || "").trim() === t);
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

/*
 * MFの取引先(partners)を顧客マスタ(customers)へ同期する。MFを正マスタとする。
 * - mf_partner_id一致 → name/name_kanaはMFで上書き、連絡先系はアプリ側が空の場合のみ補完
 * - 未一致でも正規化名が一致する既存顧客があれば、その顧客にmf_partner_idを採用(マスタ自体の名寄せ)
 * - どちらも無ければ新規insert
 * 返り値: mf_partner_id → 顧客行 のMap(案件の顧客自動紐付けに使う)
 */
async function syncPartners(accessToken, summary) {
  const partners = await mf.listPartners(accessToken);
  summary.partnersSeen = partners.length;
  summary.partnersUpserted = 0;
  const customers = await db.getCustomers();
  const byId = new Map(customers.map((c) => [String(c.id), c]));
  /* アプリ側で統合(merged_into)された顧客は、統合先の顧客に解決する */
  const resolveMerged = (c) => {
    let cur = c, hops = 0;
    while (cur && cur.merged_into && hops < 5) { cur = byId.get(String(cur.merged_into)); hops++; }
    return cur || c;
  };
  const byPartnerId = new Map(customers.filter((c) => c.mf_partner_id && !c.deleted_at).map((c) => [String(c.mf_partner_id), resolveMerged(c)]).filter(([, c]) => c && !c.deleted_at));
  const byNormName = new Map();
  customers.filter((c) => !c.merged_into && !c.deleted_at).forEach((c) => {
    const k = normalizePartnerName(c.name);
    if (k && !byNormName.has(k)) byNormName.set(k, c);
  });
  const deletedByNormName = new Map();
  customers.filter((c) => c.deleted_at).forEach((c) => {
    const k = normalizePartnerName(c.name);
    if (k && !deletedByNormName.has(k)) deletedByNormName.set(k, c);
  });

  const toInsert = [];
  for (const p of partners) {
    const depts = p.departments || [];
    const dept = depts[0] || {};
    const address = [dept.zip, dept.prefecture, dept.address1, dept.address2].filter(Boolean).join(" ");
    /* 担当者は全部署分をまとめて改行区切りで保持(複数担当者対応) */
    const persons = [...new Set(depts.map((d) => d.person_name).filter(Boolean))].join("\n");
    const fromMf = {
      name: p.name || "",
      name_kana: p.name_kana || null,
      contact_person: persons || null,
      phone: dept.tel || null,
      email: dept.email || null,
      address: address || null,
    };
    if (!fromMf.name) continue;

    /* 統合済みの行がこのpartner_idを持っている場合は、行の更新はせずMap解決のみ行う */
    const rawExisting = customers.find((c) => String(c.mf_partner_id || "") === String(p.id));
    /* 復元箱のMF顧客は墓標として残す。同期で更新・再表示・案件への自動紐付けをしない。 */
    if (rawExisting && (rawExisting.merged_into || rawExisting.deleted_at)) continue;
    /* 手動登録後に復元箱へ入れた顧客とMF名が一致した場合も、新しい通常行は作らない。
       MFのpartner_idだけを墓標へ記録し、以後の同期でも同じ行を識別できるようにする。 */
    const deletedNameHit = !rawExisting ? deletedByNormName.get(normalizePartnerName(fromMf.name)) : null;
    if (deletedNameHit) {
      if (!deletedNameHit.mf_partner_id) {
        await db.updateCustomer(deletedNameHit.id, { mf_partner_id: String(p.id) });
        deletedNameHit.mf_partner_id = String(p.id);
        summary.partnersUpserted++;
      }
      continue;
    }

    let existing = rawExisting;
    if (!existing) {
      const nameHit = byNormName.get(normalizePartnerName(fromMf.name));
      if (nameHit && !nameHit.mf_partner_id) existing = nameHit;
    }

    if (existing) {
      const patch = {};
      if (existing.mf_partner_id !== String(p.id)) patch.mf_partner_id = String(p.id);
      if (existing.name !== fromMf.name) patch.name = fromMf.name;
      if (fromMf.name_kana && existing.name_kana !== fromMf.name_kana) patch.name_kana = fromMf.name_kana;
      for (const k of ["contact_person", "phone", "email", "address"]) {
        if (!existing[k] && fromMf[k]) patch[k] = fromMf[k];
      }
      if (Object.keys(patch).length) {
        await db.updateCustomer(existing.id, patch);
        Object.assign(existing, patch);
        summary.partnersUpserted++;
      }
      byPartnerId.set(String(p.id), existing);
    } else {
      const row = { mf_partner_id: String(p.id), ...fromMf, note: "" };
      toInsert.push(row);
    }
  }
  if (toInsert.length) {
    await db.insertCustomers(toInsert);
    summary.partnersUpserted += toInsert.length;
    /* insert後のid付き行を取り直してMapへ反映(統合済みは解決) */
    const refreshed = await db.getCustomers();
    const byId2 = new Map(refreshed.map((c) => [String(c.id), c]));
    const resolve2 = (c) => { let cur = c, hops = 0; while (cur && cur.merged_into && hops < 5) { cur = byId2.get(String(cur.merged_into)); hops++; } return cur || c; };
    refreshed.forEach((c) => { if (c.mf_partner_id && !c.deleted_at) byPartnerId.set(String(c.mf_partner_id), resolve2(c)); });
  }
  return byPartnerId;
}

/* 案件に顧客が未設定で、MFのpartner_idがマスタに存在すれば顧客を自動セットするpatchを返す */
function customerPatchFor(target, partnerId, partnersById) {
  if (target.customerId || !partnerId) return {};
  const cust = partnersById.get(String(partnerId));
  if (!cust) return {};
  return { customerId: String(cust.id), customerName: cust.name };
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
  const summary = { quotesSeen: 0, quotesLinked: 0, quotesUpdated: 0, quotesQueued: 0, billingsSeen: 0, billingsUpdated: 0, billingsQueued: 0 };
  try {
    const accessToken = await ensureAccessToken();
    if (!accessToken) {
      res.status(400).json({ error: "not_connected" });
      return;
    }

    const partnersById = await syncPartners(accessToken, summary).catch((e) => {
      throw new Error(`partners sync failed: ${e.message || e}`);
    });

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
      if (existing) {
        /* 同じ見積書(mf_id不変)がMF側で金額改定・作成日変更された場合に追随する。
           紐付け先の探索(タイトル一致・取引先一致など)はもう不要なのでここで完結させる */
        const patch = {};
        if (String(existing.quoteAmount || "") !== String(q.amount)) patch.quoteAmount = String(q.amount);
        if (q.issueDate && String(existing.quoteDate || "") !== String(q.issueDate)) patch.quoteDate = q.issueDate;
        if (Object.keys(patch).length) {
          const merged = await db.updateCaseData(existing.id, patch);
          activeCases = activeCases.map((x) => (x.id === existing.id ? { id: existing.id, ...merged } : x));
          await db.insertCaseHistory(existing.id, "MF連携(自動)", "MF見積 金額改定", `${q.mfNumber || q.mfId}(見積${fmtYenLog(q.amount)})`);
          await db.insertAuditLog("MF連携(自動)", "MF見積 金額改定", `${existing.name}:${q.mfNumber || q.mfId}`);
          summary.quotesUpdated++;
        }
        continue;
      }

      let target = null;
      let isOverwrite = false;

      const titleMatches = findTitleMatch(activeCases, q.title, "mfQuoteId");
      if (titleMatches.length === 1) {
        target = titleMatches[0];
      } else {
        /* 同じ取引先で既に見積が紐付いている案件が1件だけあれば、発行日が新しい方を優先して上書きする
           (見積の再発行・改訂に対応。金額の一致は問わない) */
        const normTarget = normalizePartnerName(q.partnerName);
        const quoteLinkedSamePartner = normTarget
          ? activeCases.filter((c) => c.mfQuoteId && normalizePartnerName(c.customerName) === normTarget)
          : [];
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
      }
      if (target) {
        const quotePatch = {
          mfQuoteId: q.mfId,
          mfQuoteNumber: q.mfNumber,
          mfQuoteDate: q.issueDate || null,
          mfLinkedAt: new Date().toISOString(),
          quoteAmount: String(q.amount),
          ...customerPatchFor(target, q.partnerId, partnersById),
        };
        /* 案件の「見積日」はMFの見積作成日を正とする */
        if (q.issueDate) quotePatch.quoteDate = q.issueDate;
        /* 請求書が既に紐付いている(=請求書提出まで進んでいる)案件には、見積の紐付けで
           ステータスを「見積提出」に巻き戻さない(請求書が先に登録されたケースを想定) */
        if (!target.mfBillingId) quotePatch.status = "見積提出";
        /* 類似案件をMF上で複製して件名だけ変えた場合(=同じ取引先の既存案件へ、発行日が新しい見積として
           上書きされるケース)、金額・作成日だけでなく案件名もMFの新しい件名に追随させる。
           そうしないと金額は更新されるのに案件名だけ古いまま残ってしまう */
        const renamed = isOverwrite && q.title && q.title.trim() && q.title.trim() !== target.name;
        if (renamed) quotePatch.name = q.title.trim();
        const merged = await db.updateCaseData(target.id, quotePatch);
        activeCases = activeCases.map((x) => (x.id === target.id ? { id: target.id, ...merged } : x));
        const action = isOverwrite ? "MF見積 更新(新しい見積で上書き)" : "MF見積 自動突合";
        const renameNote = renamed ? `・案件名を更新(${target.name} → ${quotePatch.name})` : "";
        await db.insertCaseHistory(target.id, "MF連携(自動)", action, `${q.mfNumber || q.mfId}(${q.partnerName || ""}・見積${fmtYenLog(q.amount)})${renameNote}`);
        await db.insertAuditLog("MF連携(自動)", action, `${target.name}:${q.mfNumber || q.mfId}`);
        await db.resolveReviewQueueItem("quote", q.mfId, target.id);
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
        const titleMatches = findTitleMatch(activeCases, b.title, "mfBillingId");
        if (titleMatches.length === 1) target = titleMatches[0];
      }
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
      await db.resolveReviewQueueItem("billing", b.mfId, target.id);
      const patch = { ...customerPatchFor(target, b.partnerId, partnersById) };
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
