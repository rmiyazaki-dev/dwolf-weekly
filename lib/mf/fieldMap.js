/*
 * Money Forward クラウド請求書 API のレスポンスJSONのフィールド名を吸収する層。
 * フィールド名・入金ステータスのコード値は、公式APIクライアント実装
 * (https://github.com/wywy-llc/mf-invoice-api の src/@types/mf-invoice-api.d.ts, src/service/service-base.ts)
 * の型定義で確認済み。
 */

function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/*
 * MFの日付系フィールドは "2026/07/21"(due_date等)と "2026-06-11 11:38:13 +0900"(created_at等)が
 * 混在しており、いずれもISO形式(YYYY-MM-DD)ではない。<input type="date">はISO形式必須のため正規化する。
 */
function toISODate(s) {
  if (!s) return null;
  return String(s).slice(0, 10).replace(/\//g, "-");
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
    issueDate: toISODate(pick(raw, ["quote_date", "issue_date", "created_at"])),
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
    issueDate: toISODate(pick(raw, ["billing_date", "issue_date", "created_at"])),
    dueDate: toISODate(pick(raw, ["due_date"])),
    title: pick(raw, ["title", "subject"]),
    paymentStatus: pick(raw, ["payment_status"]),
    updatedAt: pick(raw, ["updated_at"]),
  };
}

/*
 * payment_status は実データで確認したところ、GETレスポンスでは数値コードではなく
 * 日本語文字列("未入金"/"入金済み"等)で返ってくる(PUT更新時のみ数値コード'0'〜'4')。
 * 万一数値コードで来た場合(2=入金済 4=振込済)にも念のため対応しておく。
 */
function isPaid(paymentStatus) {
  if (paymentStatus == null) return false;
  const s = String(paymentStatus);
  if (s === "2" || s === "4") return true;
  return s.includes("入金済") || s.includes("振込済");
}

function amountsClose(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (x === 0 || y === 0) return true; // 片方未入力なら金額不一致では弾かない
  return Math.abs(x - y) <= 1;
}

module.exports = { normalizePartnerName, extractQuoteFields, extractBillingFields, isPaid, amountsClose };
