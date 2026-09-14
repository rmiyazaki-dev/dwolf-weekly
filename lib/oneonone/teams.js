'use strict';
const {error} = require('./store');
function teamsRouting(env = process.env) {
  // 個人の通知先は公開リポジトリに置かず、サーバー設定の許可リストで固定する。
  const validEmail = value => typeof value === 'string' && /^[a-z0-9._+-]+@shimizu-gumi\.net$/.test(value);
  try {
    const manager = env.ONEONONE_TEAMS_MANAGER;
    const people = JSON.parse(env.ONEONONE_TEAMS_RECIPIENTS || 'null');
    if (!validEmail(manager) || !people || Array.isArray(people) || typeof people !== 'object' || Object.keys(people).length !== 4) throw new Error();
    for (const [email, name] of Object.entries(people)) {
      if (!validEmail(email) || email === manager || typeof name !== 'string' || !name.trim() || name.length > 80 || /[<>\u0000-\u001f]/.test(name)) throw new Error();
    }
    return {manager, people};
  } catch { throw error(503, '確認済み5名のTeams通知先をサーバーに設定してください。'); }
}
const TYPES = Object.freeze({
  submitted: {employee: false, title: '1on1資料が提出されました', action: '資料・候補日時を確認'},
  consult: {employee: false, title: '個別相談の依頼があります', action: '相談依頼を確認'},
  shared: {employee: true, title: '1on1の合意事項が共有されました', action: '合意事項を確認'},
  resuggest: {employee: true, title: '面談候補日時の再提示依頼があります', action: '候補日時を入力'},
  reminder: {employee: true, title: '1on1資料の記入時期です', action: '面談資料を作成'}
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function flowHistoryUrl(value) {
  if (!value) return null;
  try {
    const url = https(value);
    return url.hostname === 'make.powerautomate.com' && !url.port && !url.search && /^\/environments\/[a-z0-9-]+\/flows\/[a-f0-9-]{36}\/runs$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
function https(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch { throw error(503, 'Teamsの接続設定を確認してください。'); }
}
function workflowUrl(value) {
  const url = https(value);
  if ((!url.hostname.endsWith('.environment.api.powerplatform.com') && !url.hostname.endsWith('.logic.azure.com')) ||
      url.port || !/\/workflows\/[a-z0-9-]+\/triggers\/[^/]+\/paths\/invoke$/i.test(url.pathname) || !url.searchParams.get('sig')) {
    throw error(503, 'Teams Workflowsの署名付きURLを設定してください。');
  }
  return url;
}
function notification(job, member, originValue, routing) {
  const type = TYPES[job.payload?.type];
  if (!type || !UUID.test(job.id || '') || !UUID.test(job.record_id || '')) throw error(400, '通知の種類または対象が不正です。');
  const employee = String(member.m365_email || '').trim().toLowerCase();
  if (!routing || !Object.hasOwn(routing.people, employee) || employee === routing.manager) throw error(403, '確認済みのTeams通知先が設定されていません。');
  const origin = https(originValue);
  if (origin.pathname !== '/' || origin.search) throw error(503, 'D-BORDの公開URLを確認してください。');
  return {id: job.id, recipient: type.employee ? employee : routing.manager, title: type.title, memberName: routing.people[employee], url: `${origin.origin}/?oneonone=${encodeURIComponent(job.record_id)}`};
}
function workflowPayload(message) {
  // 回答やAI分析は渡さず、カードのリンク先でもD-BORDの本人確認を必須にする。
  const card = {$schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [
    {type: 'TextBlock', text: 'D-BORD 1on1', weight: 'Bolder', size: 'Medium', wrap: true},
    {type: 'TextBlock', text: message.title, weight: 'Bolder', wrap: true},
    {type: 'TextBlock', text: message.memberName, wrap: true},
    {type: 'TextBlock', text: `通知ID: ${message.id}`, isSubtle: true, size: 'Small', wrap: true}
  ], actions: [{type: 'Action.OpenUrl', title: 'D-BORDで確認', url: message.url}]};
  return {type: 'message', id: message.id, recipient: message.recipient, attachments: [{contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card}]};
}
async function sendTeams(env, request, job, member) {
  const mode = env.ONEONONE_TEAMS_MODE || 'acknowledged';
  if (!['workflows', 'acknowledged'].includes(mode)) throw error(503, 'Teamsの通知方式を確認してください。');
  if (!env.ONEONONE_TEAMS_WEBHOOK || !env.ONEONONE_TEAMS_SECRET) throw error(503, 'Teams通知が未設定です。');
  const message = notification(job, member, env.ONEONONE_APP_ORIGIN, teamsRouting(env));
  const endpoint = mode === 'workflows' ? workflowUrl(env.ONEONONE_TEAMS_WEBHOOK) : https(env.ONEONONE_TEAMS_WEBHOOK);
  let res;
  try {
    res = await request(endpoint.href, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: {'Content-Type': 'application/json', 'X-OneOnOne-Secret': env.ONEONONE_TEAMS_SECRET}, body: JSON.stringify(mode === 'workflows' ? workflowPayload(message) : message)});
  } catch { throw error(503, 'Teamsの送信結果を確認できません。フロー履歴を確認してください。'); }
  if (!res.ok) throw error([400, 401, 403, 404, 410].includes(res.status) ? 403 : 503, 'Teams通知を完了できません。フローの設定・実行履歴を確認してください。');
  if (res.status === 202 && mode === 'workflows') return {accepted: true, delivered: false, message: 'Teamsフロー受付済み・配信未確認'};
  let result; try { result = await res.json(); } catch { /* 受付応答だけを配信済みに変換しない。 */ }
  if (res.status !== 200 || result?.id !== job.id || result?.delivered !== true) throw error(503, 'Teamsへの配信完了を確認できません。');
  return {delivered: true, message: 'Teams個人チャットへ配信済み'};
}
module.exports = {sendTeams, notification, workflowPayload, workflowUrl, flowHistoryUrl, teamsRouting, TYPES};
