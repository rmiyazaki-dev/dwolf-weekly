'use strict';
const {createStore} = require('./store');
const {createIntegrations} = require('./integrations');
const {createService} = require('./service');

function isReminder(job) {
  return job?.kind === 'teams' && job?.state === 'pending' && job?.payload?.type === 'reminder';
}

// Vercel Cron is shared with the existing MF sync. Only newly queued reminders are dispatched here.
async function runScheduledReminders(env = process.env, dependencies = {}) {
  if (env.ONEONONE_ENABLED !== 'true' || env.ONEONONE_LIVE_APPROVED !== 'true') {
    return {available: false, queued: 0, dispatched: 0, states: []};
  }
  const request = dependencies.request || fetch;
  const store = dependencies.store || createStore(env, request);
  const integrations = dependencies.integrations || createIntegrations(env, request);
  const service = dependencies.service || createService(store, integrations, env);
  const tick = await service.tick(dependencies.now || new Date());
  const states = [];

  // Four employees receive at most a request and an overdue reminder per cycle.
  for (let count = 0; count < 12; count++) {
    const jobs = await store.get('oneonone_outbox', 'kind=eq.teams&state=eq.pending&order=created_at.asc&limit=100');
    const job = jobs.find(isReminder);
    if (!job) break;
    const result = await service.dispatch(null, job.id);
    if (!result.processed) break;
    states.push(result.state);
  }
  return {available: true, queued: Number(tick?.queued) || 0, dispatched: states.length, states};
}

module.exports = {runScheduledReminders};
