'use strict';

const crypto = require('node:crypto');
const {error} = require('./store');

const CALENDAR_ACCOUNT = 'rmiyazaki@copros.co.jp';
const GRAPH_SCOPES = ['offline_access', 'https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Calendars.ReadWrite'];
const stateLifetimeMs = 10 * 60 * 1000;

function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || ''); }
function base64url(value) { return Buffer.from(value).toString('base64url'); }

function appOrigin(env) {
  try {
    const url = new URL(env.ONEONONE_APP_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

function tokenKey(env) {
  let key;
  try { key = Buffer.from(String(env.ONEONONE_CALENDAR_TOKEN_KEY || ''), 'base64url'); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw error(503, 'コプロス予定表の接続設定を確認してください。');
  return key;
}

function calendarConfiguration(env = process.env) {
  const calendarAccount = String(env.ONEONONE_COPROS_MAILBOX || '').toLowerCase();
  const origin = appOrigin(env);
  const stateSecret = String(env.ONEONONE_CALENDAR_STATE_SECRET || '');
  let validTokenKey = false;
  try { validTokenKey = tokenKey(env).length === 32; } catch { /* 設定不足は未接続として扱う。 */ }
  const calendar = calendarAccount === CALENDAR_ACCOUNT && uuid(env.ONEONONE_COPROS_TENANT_ID) && uuid(env.ONEONONE_COPROS_CLIENT_ID) && !!env.ONEONONE_COPROS_CLIENT_SECRET && stateSecret.length >= 32 && validTokenKey && !!origin && env.ONEONONE_CALENDAR_SCOPE_APPROVED === 'true';
  return {calendar, calendarAccount: calendar ? CALENDAR_ACCOUNT : null, origin, tenantId: env.ONEONONE_COPROS_TENANT_ID || '', clientId: env.ONEONONE_COPROS_CLIENT_ID || '', clientSecret: env.ONEONONE_COPROS_CLIENT_SECRET || '', stateSecret};
}

function signState(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

function createCalendarState(env, userId, now = Date.now()) {
  const config = calendarConfiguration(env);
  if (!config.calendar || !uuid(userId)) throw error(503, 'コプロス予定表の接続設定を確認してください。');
  const value = base64url(JSON.stringify({userId, expiresAt: now + stateLifetimeMs, nonce: crypto.randomBytes(16).toString('base64url')}));
  return `${value}.${signState(value, config.stateSecret)}`;
}

function verifyCalendarState(env, state, now = Date.now()) {
  const config = calendarConfiguration(env);
  if (!config.calendar || typeof state !== 'string' || state.length > 4096) throw error(400, '予定表の接続を確認できません。もう一度お試しください。');
  const [value, signature, extra] = state.split('.');
  if (!value || !signature || extra) throw error(400, '予定表の接続を確認できません。もう一度お試しください。');
  const expected = Buffer.from(signState(value, config.stateSecret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw error(400, '予定表の接続を確認できません。もう一度お試しください。');
  let payload;
  try { payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw error(400, '予定表の接続を確認できません。もう一度お試しください。'); }
  if (!uuid(payload?.userId) || !Number.isSafeInteger(payload?.expiresAt) || payload.expiresAt < now || payload.expiresAt > now + stateLifetimeMs + 1000 || typeof payload.nonce !== 'string') throw error(400, '予定表の接続を確認できません。もう一度お試しください。');
  return payload;
}

function calendarAuthorizeUrl(env, userId) {
  const config = calendarConfiguration(env);
  if (!config.calendar) throw error(503, 'コプロス予定表の接続設定を確認してください。');
  const query = new URLSearchParams({client_id: config.clientId, response_type: 'code', redirect_uri: `${config.origin}/api/oneonone-calendar-callback`, response_mode: 'query', scope: GRAPH_SCOPES.join(' '), state: createCalendarState(env, userId), prompt: 'select_account'});
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize?${query}`;
}

async function tokenRequest(config, request, body) {
  let res;
  try { res = await request(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(12000)}); }
  catch { throw error(503, 'コプロス予定表に接続できません。'); }
  if (!res.ok) throw error(503, 'コプロス予定表の接続を更新できません。接続し直してください。');
  const token = await res.json().catch(() => null);
  if (!token?.access_token) throw error(503, 'コプロス予定表の接続を更新できません。接続し直してください。');
  return token;
}

function code(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) throw error(400, '予定表の接続を確認できません。もう一度お試しください。');
  return value;
}

async function exchangeCalendarCode(env, value, request = fetch) {
  const config = calendarConfiguration(env);
  if (!config.calendar) throw error(503, 'コプロス予定表の接続設定を確認してください。');
  return tokenRequest(config, request, {grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code: code(value), redirect_uri: `${config.origin}/api/oneonone-calendar-callback`, scope: GRAPH_SCOPES.join(' ')});
}

async function refreshCalendarAccess(env, refreshToken, request = fetch) {
  const config = calendarConfiguration(env);
  if (!config.calendar || typeof refreshToken !== 'string' || refreshToken.length < 8) throw error(503, 'コプロス予定表の接続を確認してください。');
  return tokenRequest(config, request, {grant_type: 'refresh_token', client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, scope: GRAPH_SCOPES.join(' ')});
}

async function calendarIdentity(accessToken, request = fetch) {
  let res;
  try { res = await request('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {headers: {Authorization: `Bearer ${accessToken}`}, signal: AbortSignal.timeout(12000)}); }
  catch { throw error(503, 'コプロス予定表の接続を確認できません。'); }
  if (!res.ok) throw error(503, 'コプロス予定表の接続を確認できません。');
  const profile = await res.json().catch(() => ({}));
  const address = String(profile.mail || profile.userPrincipalName || '').toLowerCase();
  if (address !== CALENDAR_ACCOUNT) throw error(403, 'コプロスの宮﨑さんの予定表で接続してください。');
  return address;
}

function encryptToken(env, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptToken(env, value) {
  try {
    const [version, iv, tag, encrypted, extra] = String(value || '').split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted || extra) throw new Error('format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(env), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const token = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    if (token.length < 8) throw new Error('token');
    return token;
  } catch { throw error(503, 'コプロス予定表の接続を更新できません。接続し直してください。'); }
}

async function loadCalendarToken(store, env) {
  if (!store) return null;
  const [row] = await store.get('oneonone_calendar_tokens', 'id=eq.1&select=mailbox,token');
  if (!row || String(row.mailbox || '').toLowerCase() !== CALENDAR_ACCOUNT) return null;
  return decryptToken(env, row.token);
}

async function saveCalendarToken(store, env, refreshToken) {
  if (!store || typeof refreshToken !== 'string' || refreshToken.length < 8) throw error(503, 'コプロス予定表の接続を保存できません。');
  await store.call('oneonone_calendar_tokens?on_conflict=id', 'POST', {id: 1, mailbox: CALENDAR_ACCOUNT, token: encryptToken(env, refreshToken), connected_at: new Date().toISOString(), updated_at: new Date().toISOString()}, {Prefer: 'resolution=merge-duplicates,return=minimal'});
}

module.exports = {CALENDAR_ACCOUNT, GRAPH_SCOPES, calendarConfiguration, calendarAuthorizeUrl, createCalendarState, verifyCalendarState, exchangeCalendarCode, refreshCalendarAccess, calendarIdentity, encryptToken, decryptToken, loadCalendarToken, saveCalendarToken};
