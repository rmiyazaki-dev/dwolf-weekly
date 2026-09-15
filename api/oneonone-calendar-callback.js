'use strict';

const {createStore, error} = require('../lib/oneonone/store');
const {verifyCalendarState, exchangeCalendarCode, calendarIdentity, saveCalendarToken} = require('../lib/oneonone/calendar');

function fail(res, status, message) {
  return res.status(status).send(message);
}

function handlerFactory(env = process.env, request = fetch, storeFactory = createStore) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.method !== 'GET') throw error(405, 'この操作は利用できません。');
      const code = req.query?.code;
      const state = req.query?.state;
      if (req.query?.error || !code || !state) throw error(400, '予定表の接続を確認できません。もう一度お試しください。');

      const signed = verifyCalendarState(env, state);
      const store = storeFactory(env, request);
      const [manager] = await store.get('oneonone_members', `user_id=eq.${signed.userId}&role=eq.manager&active=eq.true&select=user_id`);
      if (!manager) throw error(403, '予定表の接続を確認できません。');

      const token = await exchangeCalendarCode(env, code, request);
      if (!token.refresh_token) throw error(503, 'コプロス予定表の接続を保存できません。もう一度お試しください。');
      await calendarIdentity(token.access_token, request);
      await saveCalendarToken(store, env, token.refresh_token);

      // Vercel's response wrapper does not reliably support writeHead().
      // Use the standard statusCode/header path after the token is safely stored.
      res.statusCode = 302;
      res.setHeader('Location', '/?calendar=connected#oneonone');
      return res.end();
    } catch (e) {
      // 認可コード、状態値、トークン、プロバイダー応答は画面やログに出さない。
      const status = e.status || 500;
      return fail(res, status, status < 500 ? e.message : '予定表の接続を完了できませんでした。設定を確認してもう一度お試しください。');
    }
  };
}

module.exports = handlerFactory();
module.exports.handlerFactory = handlerFactory;
