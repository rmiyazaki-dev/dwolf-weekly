'use strict';
const {timingSafeEqual} = require('node:crypto');
const {createStore, error} = require('../lib/oneonone/store');
const {createService} = require('../lib/oneonone/service');
const {createIntegrations} = require('../lib/oneonone/integrations');
function same(a, b) { if (!a || !b) return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function handlerFactory(env = process.env, request = fetch) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!['GET', 'POST'].includes(req.method)) throw error(405, 'この操作は利用できません。');
      if (env.ONEONONE_ENABLED !== 'true') return res.status(200).json({available: false});
      const action = req.query.action || 'bootstrap';
      if (req.method === 'GET' && !['bootstrap', 'detail'].includes(action)) throw error(405, 'POSTで実行してください。');
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw error(415, '送信形式を確認してください。');
        if (req.headers.origin && req.headers.origin !== env.ONEONONE_APP_ORIGIN) throw error(403, '送信元が許可されていません。');
        if (JSON.stringify(req.body || {}).length > 60000) throw error(413, '入力が長すぎます。');
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const store = createStore(env, request), service = createService(store, createIntegrations(env, request), env);
      if (action === 'dispatch' && same(token, env.ONEONONE_JOB_SECRET)) return res.status(200).json(await service.dispatch(null));
      if (action === 'tick' && same(token, env.ONEONONE_JOB_SECRET)) return res.status(200).json(await service.tick());
      const actor = await store.actor(token);
      return res.status(200).json(await service.action(actor, action, req.method === 'GET' ? req.query : req.body));
    } catch (e) {
      // 回答・トークン・外部APIの応答本文はログに残さない。
      const status = e.status || 500;
      return res.status(status).json({error: status < 500 ? e.message : '1on1の処理を完了できません。接続設定または保存状況を確認してください。', code: status === 409 ? 'conflict' : 'request_failed'});
    }
  };
}
module.exports = handlerFactory();
module.exports.handlerFactory = handlerFactory;
