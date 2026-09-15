'use strict';
const D = require('../../oneonone-domain');
const {error} = require('./store');
function createService(store, integrations, env = process.env) {
  const manager = actor => { if (actor.role !== 'manager') throw error(403, '面談担当者のみ利用できます。'); };
  const uuid = value => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')) throw error(400, '対象が不正です。'); return value; };
  async function record(actor, id) { const [r] = await store.get('oneonone_records', `id=eq.${uuid(id)}`); if (!r || actor.role !== 'manager' && r.user_id !== actor.user_id) throw error(403, 'この面談は閲覧できません。'); return r; }
  const commit = (actor, r, revision, op, data) => { if (!Number.isInteger(revision) || revision < 0) throw error(400, '更新版が不正です。'); return store.rpc('oneonone_commit', {p_actor: actor.user_id, p_record: r.id, p_revision: revision, p_op: op, p_data: data}); };
  async function notifyCommit(actor, r, revision, op, data) {
    const result = await commit(actor, r, revision, op, data);
    const [job] = await store.get('oneonone_outbox', `record_id=eq.${r.id}&kind=eq.teams&state=eq.pending&order=created_at.desc&limit=1`);
    if (job) { try { await dispatch(null, job.id); } catch { /* 提出は確定済み。通知キューを残して後から確認する。 */ } }
    return result;
  }
  const latest = async r => (await store.get('oneonone_submissions', `record_id=eq.${r.id}&order=version.desc&limit=1`))[0];
  async function ensureCycle(id) {
    if (!/^20\d{2}-(02|04|06|08|10|12)$/.test(id) || id < '2026-10' || id > D.shiftCycle(D.cycleFor(), 12)) throw error(400, '実施回を確認してください。');
    await store.insert('oneonone_cycles', {id}, true);
  }
  async function audit(actor, id, action) { await store.insert('oneonone_audit', {actor: actor.user_id, record_id: id, action}); }
  async function bootstrap(actor) {
    const cycle = D.cycleFor(); await ensureCycle(cycle);
    const members = await store.get('oneonone_members', `active=eq.true${actor.role === 'manager' ? '' : `&user_id=eq.${actor.user_id}`}&order=name`);
    for (const m of members.filter(m => m.role === 'employee')) await store.insert('oneonone_records', {user_id: m.user_id, cycle}, true);
    const records = await store.get('oneonone_records', `select=id,user_id,cycle,revision,submitted_version,meeting,shared,consultation,updated_at${actor.role === 'manager' ? '' : `&user_id=eq.${actor.user_id}`}&order=cycle.desc&limit=200`);
    const cycles = await store.get('oneonone_cycles', 'order=id.desc&limit=36');
    const consultations = records.filter(r => r.consultation?.status === 'requested');
    const calendar = actor.role === 'manager' && integrations.calendarReady ? await integrations.calendarReady() : false;
    return {actor: {user_id: actor.user_id, name: actor.name, role: actor.role}, members: members.map(m => ({user_id: m.user_id, name: m.name, role: m.role})), cycle, cycles, records, consultations, config: actor.role === 'manager' ? {...integrations.config, calendar} : {ai: integrations.config.ai}, alternateContact: env.ONEONONE_ALTERNATE_CONTACT || '', retention: env.ONEONONE_RETENTION_NOTICE || '保存期間は運用開始前に決定します。', available: true};
  }
  async function detail(actor, id) {
    const r = await record(actor, id);
    const submissions = await store.get('oneonone_submissions', `user_id=eq.${r.user_id}&order=cycle.desc,version.desc&limit=200`);
    const ownVersions = submissions.filter(s => s.record_id === r.id), current = ownVersions[0];
    const pastRecords = await store.get('oneonone_records', `user_id=eq.${r.user_id}&cycle=lt.${r.cycle}&select=id,cycle,shared,meeting&order=cycle.desc&limit=6`);
    const out = {record: {...r}, current: current || null, versions: ownVersions, history: submissions.filter(s => s.cycle < r.cycle), pastRecords};
    if (actor.role === 'manager') {
      delete out.record.draft;
      const [privateRow] = await store.get('oneonone_private', `record_id=eq.${r.id}`);
      out.private = privateRow?.data || {};
      const previous = submissions.find(s => s.cycle === D.shiftCycle(r.cycle, -2));
      out.trends = current ? D.trends(current, previous) : [];
      out.sheet = current ? (out.private.sheet?.submissionId === current.id ? out.private.sheet : D.sheet(current, previous)) : null;
      const jobs = await store.get('oneonone_outbox', `record_id=eq.${r.id}&select=id,kind,state,attempts,updated_at,result&order=created_at.desc&limit=20`);
      out.jobs = jobs.map(j => ({...j, result: {message: j.result?.message || '', accepted: j.result?.accepted === true}}));
    }
    await audit(actor, id, 'read');
    return out;
  }
  async function allCases() {
    const rows = []; for (let offset = 0; offset < 100000; offset += 1000) { const page = await store.get('cases', `select=id,data&order=id&limit=1000&offset=${offset}`); rows.push(...page); if (page.length < 1000) return rows; }
    throw error(503, '案件数が集計上限を超えています。');
  }
  async function dispatch(actor, id) {
    if (actor) manager(actor);
    if (id) { uuid(id); const [job] = await store.get('oneonone_outbox', `id=eq.${id}`); if (!job) throw error(404, '通知がありません。'); if (job.kind === 'teams' && job.result?.accepted) throw error(409, 'Teamsフローで受付済みです。重複防止のため再送せず、フローの実行履歴を確認してください。'); }
    const [job] = await store.rpc('oneonone_claim', {p_id: id || null});
    if (!job) return {processed: false};
    const [r] = await store.get('oneonone_records', `id=eq.${job.record_id}`);
    const [member] = await store.get('oneonone_members', `user_id=eq.${r.user_id}&active=eq.true`);
    let state = 'sent', result;
    try {
      if (!member) throw error(409, '対象者の利用が停止されています。');
      const configured = job.kind === 'calendar' && integrations.calendarReady ? await integrations.calendarReady() : integrations.config[job.kind];
      if (!configured) { state = 'not_configured'; result = {message: '連携未設定'}; }
      else {
        result = await integrations[job.kind](job, member);
        if (job.kind === 'teams' && result.accepted && !result.delivered) state = 'unknown';
      }
    } catch (e) {
      state = e.status === 409 || e.status === 403 ? 'failed' : 'unknown'; result = {message: e.message};
      if (job.kind === 'calendar' && e.status === 409) { state = 'sent'; result = {...job.payload.previous, status: job.payload.previous?.eventId ? 'confirmed' : 'conflict', reason: e.message}; }
    }
    await store.rpc('oneonone_finish', {p_id: job.id, p_attempt: job.attempts, p_state: state, p_result: result});
    return {processed: true, state};
  }
  async function tick(now=new Date()) {
    if(env.ONEONONE_LIVE_APPROVED!=='true')return {queued:0};
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    const cycles=await store.get('oneonone_cycles','order=id.desc&limit=36');let queued=0;
    for(const c of cycles){if(!c.opens_at||c.opens_at>today)continue;const records=await store.get('oneonone_records',`cycle=eq.${c.id}&submitted_version=eq.0`);for(const r of records){const phase=c.deadline&&c.deadline<today?'overdue':'request';const inserted=await store.insert('oneonone_outbox',{record_id:r.id,kind:'teams',dedupe:`reminder:${r.id}:${phase}`,payload:{type:'reminder'}},true);queued+=Array.isArray(inserted)?inserted.length:0;}}
    return {queued};
  }
  async function action(actor, name, input = {}) {
    if (name === 'bootstrap') return bootstrap(actor);
    if (name === 'detail') return detail(actor, input.id);
    if (name === 'dispatch') return dispatch(actor, input.id);
    if (name === 'calendar_connect') { manager(actor); return {url: integrations.calendarAuthorizeUrl(actor)}; }
    if (name === 'cycle') { manager(actor); await ensureCycle(input.cycle); if (input.deadline || input.opens_at) { D.date(input.deadline); D.date(input.opens_at); if(input.opens_at && input.deadline && input.opens_at>input.deadline)throw error(400,'記入開始日は提出期限以前にしてください。'); await store.call(`oneonone_cycles?id=eq.${input.cycle}`, 'PATCH', {deadline: input.deadline || null,opens_at:input.opens_at||null}); } const members = await store.get('oneonone_members', 'active=eq.true&role=eq.employee'); for (const m of members) await store.insert('oneonone_records', {user_id: m.user_id, cycle: input.cycle}, true); return bootstrap(actor); }
    const r = await record(actor, input.id);
    if (['draft', 'submit'].includes(name)) {
      if (actor.user_id !== r.user_id) throw error(403, '本人の回答は編集できません。');
      if (name === 'submit' && env.ONEONONE_LIVE_APPROVED !== 'true') throw error(503, '運用開始前です。利用目的・保存期間・連携設定の確認後に提出を開始します。');
      const clean=D.sanitizeDraft(input.body,name==='submit');
      if(name==='submit') {
        const [previous]=await store.get('oneonone_submissions',`user_id=eq.${r.user_id}&cycle=lt.${r.cycle}&order=cycle.desc,version.desc&limit=1`);
        if(previous?.body.goal?.text && (previous.body.goal.text!==clean.goal.text || previous.body.goal.due!==clean.goal.due) && !clean.goal.changeReason)throw error(400,'前回の成長目標を変える場合は、見直し理由を記入してください。');
        clean.aiProcessingDisclosed=integrations.config.ai;
        clean.noticeVersion='1.0';clean.retentionNotice=env.ONEONONE_RETENTION_NOTICE||'';
      }
      return (name === 'submit' ? notifyCommit : commit)(actor, r, input.revision, name, clean);
    }
    if (name === 'consult' || name === 'resuggest') return notifyCommit(actor, r, input.revision, name, {});
    if (name === 'consult_done') return commit(actor, r, input.revision, name, {});
    if (name === 'acknowledge') return commit(actor, r, input.revision, name, {correction: D.str(input.correction)});
    if(name==='progress') {
      if(!r.shared.publishedAt || input.sharedVersion!==r.shared.version || !Array.isArray(input.progress) || input.progress.length!==r.shared.actions.length)throw error(409,'最新の合意事項を確認してください。');
      const progress=input.progress.map(p=>{if(!['未着手','進行中','完了','見直し','中止'].includes(p.status)||!['未確認','受けられた','一部','受けられていない'].includes(p.supportReceived))throw error(400,'進捗を確認してください。');return{status:p.status,supportReceived:p.supportReceived,result:D.str(p.result,300)};});
      return commit(actor,r,input.revision,name,progress);
    }
    if (name === 'feedback') {
      const data = {}; for (const k of ['heard', 'clear', 'helpful']) { const value = input[k]; if (![null, 1, 2, 3, 4, 5, 'decline'].includes(value)) throw error(400, '振り返りの回答を確認してください。'); data[k] = value; } data.comment = D.str(input.comment);
      return commit(actor, r, input.revision, name, data);
    }
    manager(actor);
    if (name === 'share') return notifyCommit(actor, r, input.revision, name, D.sharedRecord(input.body));
    const current = await latest(r);
    if (!current) throw error(409, '提出資料がありません。');
    if (['availability', 'schedule', 'cancel'].includes(name)) {
      if (name === 'availability') return {candidates: await integrations.availability(current.body.candidates, r.meeting?.eventId)};
      if (name === 'schedule' && (!current.body.candidates.includes(input.start) || new Date(input.start + ':00+09:00') <= new Date() || input.submissionId !== current.id)) throw error(409, '最新の資料から未来の候補日時を選んでください。');
      if (name === 'cancel' && !r.meeting.eventId) throw error(409, '取消対象の予定がありません。');
      return commit(actor, r, input.revision, name, {start: input.start || null, submissionId: current.id});
    }
    const [privateRow] = await store.get('oneonone_private', `record_id=eq.${r.id}`), data = privateRow?.data || {};
    if (name === 'generate') {
      const [previous] = await store.get('oneonone_submissions', `user_id=eq.${r.user_id}&cycle=eq.${D.shiftCycle(r.cycle, -2)}&order=version.desc&limit=1`);
      const today=new Date().toISOString().slice(0,10);
      data.aiRuns=(data.aiRuns||[]).filter(at=>at.startsWith(today));
      if(data.aiRuns.length>=20)throw error(429,'この面談資料の本日の生成回数は上限に達しました。保存済みのシートをご利用ください。');
      if(integrations.config.ai && current.body.aiProcessingDisclosed!==true)data.sheet={...D.sheet(current,previous),notice:'この提出版ではAI利用の案内を確認していないため、定型案を表示しています。'};
      else {data.sheet = await integrations.generate(current, previous);if(integrations.config.ai)data.aiRuns.push(new Date().toISOString());}
      data.sheet.createdAt = new Date().toISOString();
      data.sheetHistory=[...(data.sheetHistory||[]),D.copy(data.sheet)];
    } else if (name === 'review_sheet') {
      if (!data.sheet || data.sheet.submissionId !== current.id) throw error(409, '最新の面談シートを生成してください。');
      data.sheet.reviewed = true; data.sheet.reviewedAt = new Date().toISOString();
    } else if (name === 'note') data.note = D.str(input.note, 3000);
    else if (name === 'metrics') {
      const [member] = await store.get('oneonone_members', `user_id=eq.${r.user_id}`);
      const snapshot = D.metrics(await allCases(), member.aliases, r.cycle);
      data.evaluations = [...(data.evaluations || []), {facts: D.evaluationFacts(current, snapshot), at: new Date().toISOString(), decision: ''}];
      if (data.evaluations.length > 30) throw error(409, 'この回の取得回数が上限に達しました。');
    } else if (name === 'evaluate') {
      const ev = data.evaluations?.at(-1); if (!ev) throw error(409, '業績を取得してください。');
      data.decisions = [...(data.decisions || []), {factsAt: ev.at, text: D.str(input.decision, 2000), author: actor.user_id, at: new Date().toISOString()}];
    } else throw error(400, '操作が不正です。');
    return commit(actor, r, input.revision, 'private', data);
  }
  return {action, dispatch, tick};
}
module.exports = {createService};
