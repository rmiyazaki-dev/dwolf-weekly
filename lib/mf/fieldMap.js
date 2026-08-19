/*
 * Money Forward クラウド請求書 API のレスポンスJSONのフィールド名を吸収する層。
 * 見積書(quotes)・請求書(billings)一覧APIの正確なレスポンス構造は実装時点で未確認のため、
 * 生JSONへのアクセスはこのファイルに完全集約する。実データ確認後のズレ修正はここだけで完結させる。
 *
 * TODO(実データ確認後に要修正): 以下のプロパティ名は公式ドキュメント・実装例から推測した仮のもの。
 */

function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function normalizePartnerName(name) {
  if (!name) return "";
  return String(name)
    .replace(/[\s　]+/g, "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角英数記号→半角
    .replace(/株式会社|（株）|\(株\)/g, "")
    .replace(/有限会社|（有）|\(有\)/g, "")
    .toLowerCase();
}

function extractQuoteFields(raw) {
  return {
    mfId: String(pick(raw, ["id"])),
    mfNumber: pick(raw, ["quote_number", "number"]),
    partnerId: pick(raw, ["partner_id", "partner.id"]),
    partnerName: pick(raw, ["partner_name", "partner.name", "department_name"]),
    amount: Number(pick(raw, ["total_price", "total_amount", "billing_amount"])) || 0,
    issueDate: pick(raw, ["quote_date", "issue_date", "created_at"]),
    title: pick(raw, ["title", "subject"]),
    updatedAt: pick(raw, ["updated_at"]),
  };
}

function extractBillingFields(raw) {
  return {
    mfId: String(pick(raw, ["id"])),
    mfNumber: pick(raw, ["billing_number", "number"]),
    partnerId: pick(raw, ["partner_id", "partner.id"]),
    partnerName: pick(raw, ["partner_name", "partner.name", "department_name"]),
    amount: Number(pick(raw, ["total_price", "total_amount", "billing_amount"])) || 0,
    issueDate: pick(raw, ["billing_date", "issue_date", "created_at"]),
    paymentStatus: pick(raw, ["payment_status"]),
    relatedQuoteId: pick(raw, ["quote_id", "related_quote_id"]),
    updatedAt: pick(raw, ["updated_at"]),
  };
}

/* payment_status の値のバリエーション(コード/日本語文字列どちらもあり得るため両対応) */
function isPaid(paymentStatus) {
  if (paymentStatus == null) return false;
  const s = String(paymentStatus);
  return s === "1" || s === "settled" || s === "paid" || s.includes("入金済");
}

function amountsClose(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (x === 0 || y === 0) return true; // 片方未入力なら金額不一致では弾かない
  return Math.abs(x - y) <= 1;
}

module.exports = { normalizePartnerName, extractQuoteFields, extractBillingFields, isPaid, amountsClose };
