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
    dueDate: pick(raw, ["due_date"]),
    paymentStatus: pick(raw, ["payment_status"]),
    updatedAt: pick(raw, ["updated_at"]),
  };
}

/*
 * payment_status のコード値(確認済み): 0=未設定 1=未入金 2=入金済 3=未払い 4=振込済
 * 2(入金済)・4(振込済)のいずれも入金が確認された状態として扱う。
 */
function isPaid(paymentStatus) {
  if (paymentStatus == null) return false;
  const s = String(paymentStatus);
  return s === "2" || s === "4";
}

function amountsClose(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (x === 0 || y === 0) return true; // 片方未入力なら金額不一致では弾かない
  return Math.abs(x - y) <= 1;
}

module.exports = { normalizePartnerName, extractQuoteFields, extractBillingFields, isPaid, amountsClose };
