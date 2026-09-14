'use strict';
const {timingSafeEqual} = require('node:crypto');
const mfSync = require('./mf/sync');
const {runScheduledReminders} = require('../lib/oneonone/schedule');

function same(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function capture(handler, request) {
  return new Promise(async resolve => {
    let status = 500, payload = {};
    const response = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { payload = value || {}; resolve({status, payload}); }
    };
    try {
      await handler(request, response);
    } catch {
      resolve({status: 500, payload: {error: 'daily_task_failed'}});
    }
  });
}

function handlerFactory(env = process.env, dependencies = {}) {
  const sync = dependencies.mfSync || mfSync;
  const reminders = dependencies.runScheduledReminders || runScheduledReminders;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!same(String(req.headers?.authorization || '').replace(/^Bearer /, ''), env.CRON_SECRET)) {
      return res.status(401).json({error: 'unauthorized'});
    }

    const mf = await capture(sync, {
      method: 'GET',
      url: '/api/mf/sync',
      headers: {authorization: 'Bearer ' + env.CRON_SECRET}
    });
    let oneonone;
    try {
      oneonone = await reminders(env);
    } catch {
      oneonone = {available: env.ONEONONE_ENABLED === 'true', queued: 0, dispatched: 0, states: [], error: 'schedule_failed'};
    }
    const ok = mf.status >= 200 && mf.status < 300 && !oneonone.error;
    return res.status(ok ? 200 : 502).json({
      ok,
      mf: {status: mf.status},
      oneonone
    });
  };
}

module.exports = handlerFactory();
module.exports.handlerFactory = handlerFactory;
