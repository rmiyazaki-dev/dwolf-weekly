'use strict';
function error(status, message) { return Object.assign(new Error(message), {status}); }
function createStore(env = process.env, request = fetch) {
  const base = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  async function call(path, method = 'GET', body, extra = {}) {
    if (!base || !key) throw error(503, '1on1の保存先が未設定です。');
    let res;
    try { res = await request(`${base}/rest/v1/${path}`, {method, headers: {apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000)}); }
    catch { throw error(503, '保存先に接続できません。再読込して保存状況を確認してください。'); }
    if (!res.ok) { const data = await res.json().catch(() => ({})); if (['40001', '23505'].includes(data.code)) throw error(409, '別の操作で更新されています。再読込して最新の内容を確認してください。'); if (data.code === '42501') throw error(403, 'この操作は許可されていません。'); throw error(503, '1on1の保存処理を完了できません。管理者に連絡してください。'); }
    return res.status === 204 ? null : res.json();
  }
  const get = (table, query = '') => call(`${table}?${query}`);
  const insert = (table, body, ignore = false) => {
    const conflict = {oneonone_records:'user_id,cycle',oneonone_outbox:'dedupe'}[table];
    return call(table + (ignore && conflict ? `?on_conflict=${conflict}` : ''), 'POST', body, {Prefer: `${ignore ? 'resolution=ignore-duplicates,' : ''}return=representation`});
  };
  const rpc = (name, args) => call(`rpc/${name}`, 'POST', args);
  async function actor(token) {
    if (!base || !key) throw error(503, '1on1の保存先が未設定です。');
    if (!token) throw error(401, 'ログインし直してください。');
    const res = await request(`${base}/auth/v1/user`, {headers: {apikey: key, Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10000)});
    if (!res.ok) throw error(401, 'ログインし直してください。');
    const user = await res.json();
    if (!/^[0-9a-f-]{36}$/i.test(user.id || '')) throw error(401, '本人確認に失敗しました。');
    const [member] = await get('oneonone_members', `user_id=eq.${user.id}&active=eq.true`);
    if (!member) throw error(403, '1on1の利用対象ではありません。');
    return member;
  }
  return {get, insert, rpc, actor, call};
}
module.exports = {createStore, error};
