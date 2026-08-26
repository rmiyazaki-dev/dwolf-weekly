/*
 * cases / case_history / audit_log / mf_review_queue / kv 用の薄いラッパー。
 *
 * 以前は index.html と同じ anon key を使っていたが、setup-auth.sql で全テーブルを
 * RLS有効・ログイン必須にしたため anon key では読み書きできなくなった。
 * MF同期はサーバー側でユーザーのログインセッションを持たないので、
 * RLSを通過できる SUPABASE_SERVICE_ROLE_KEY を使う。
 * (このコードはVercelのサーバー上でのみ動き、ブラウザには配信されない)
 */

function baseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  return url.replace(/\/$/, "");
}

async function anonFetch(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const res = await fetch(`${baseUrl()}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getActiveCases() {
  const rows = await anonFetch("cases?select=id,data&order=id.desc");
  return (rows || []).map((r) => ({ id: r.id, ...r.data })).filter((c) => !c.archived);
}

async function findCaseByMfId(field, mfId) {
  const rows = await anonFetch(`cases?select=id,data&data->>${field}=eq.${encodeURIComponent(mfId)}`);
  if (!rows || !rows[0]) return null;
  return { id: rows[0].id, ...rows[0].data };
}

async function updateCaseData(id, dataPatch) {
  const rows = await anonFetch(`cases?id=eq.${id}&select=data`);
  const current = (rows && rows[0] && rows[0].data) || {};
  const merged = { ...current, ...dataPatch, updatedAt: Date.now() };
  await anonFetch(`cases?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ data: merged, updated_at: new Date().toISOString() }),
  });
  return merged;
}

async function insertCaseHistory(caseId, author, action, detail) {
  await anonFetch("case_history", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ case_id: caseId, author, action, detail }),
  });
}

async function insertAuditLog(author, action, detail) {
  await anonFetch("audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ author, action, detail }),
  });
}

async function queueReviewItem(item) {
  /* on_conflictを明示しないと、PostgRESTは主キー(id)基準でしか重複解決してくれず、
     別のUNIQUE制約(type, mf_id)には ignore-duplicates が効かず409になる */
  await anonFetch("mf_review_queue?on_conflict=type,mf_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(item),
  });
}

async function getCustomers() {
  return (await anonFetch("customers?select=*&order=id.asc")) || [];
}

async function insertCustomers(rows) {
  if (!rows.length) return;
  await anonFetch("customers", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function updateCustomer(id, patch) {
  await anonFetch(`customers?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

/*
 * 自動突合が成立した際、同じ(type, mf_id)がまだ「要確認リスト」にpending状態で
 * 残っていれば、linked扱いにして片付ける(後から一致するようになった場合の後始末)。
 */
async function resolveReviewQueueItem(type, mfId, caseId) {
  await anonFetch(`mf_review_queue?type=eq.${type}&mf_id=eq.${encodeURIComponent(mfId)}&status=eq.pending`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "linked", linked_case_id: caseId, resolved_by: "MF連携(自動)", resolved_at: new Date().toISOString() }),
  });
}

async function kvGet(key) {
  const rows = await anonFetch(`kv?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows && rows[0] ? rows[0].value : null;
}

async function kvSet(key, value) {
  await anonFetch("kv", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

module.exports = {
  getActiveCases,
  findCaseByMfId,
  updateCaseData,
  insertCaseHistory,
  insertAuditLog,
  queueReviewItem,
  resolveReviewQueueItem,
  getCustomers,
  insertCustomers,
  updateCustomer,
  kvGet,
  kvSet,
};
