/*
 * mf_tokens テーブル専用。SUPABASE_SERVICE_ROLE_KEY でRLSをバイパスして操作する。
 * このファイルはサーバーサイド(api/mf/*)からのみ呼び出すこと。index.html には絶対に含めない。
 */

function baseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  return url.replace(/\/$/, "");
}

async function adminFetch(path, opts = {}) {
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
    throw new Error(`Supabase(admin) ${res.status}: ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getMfTokens() {
  const rows = await adminFetch("mf_tokens?id=eq.1&select=*");
  return (rows && rows[0]) || null;
}

async function upsertMfTokens(patch) {
  await adminFetch("mf_tokens", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: 1, updated_at: new Date().toISOString(), ...patch }),
  });
}

module.exports = { getMfTokens, upsertMfTokens };
