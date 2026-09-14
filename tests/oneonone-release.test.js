'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {handlerFactory} = require('../api/oneonone');
const {teamsRouting, sendTeams, notification} = require('../lib/oneonone/teams');
const {configuration, createIntegrations} = require('../lib/oneonone/integrations');
const routingEnv = {
  ONEONONE_TEAMS_MANAGER: 'test-manager@shimizu-gumi.net',
  ONEONONE_TEAMS_RECIPIENTS: JSON.stringify(Object.fromEntries([1,2,3,4].map(i => [`test-staff${i}@shimizu-gumi.net`, `テスト社員${i}`])))
};
const job = {id:'20000000-0000-4000-8000-000000000001',record_id:'30000000-0000-4000-8000-000000000001',payload:{type:'submitted'}};
test('機能未有効では保存先・通知先へ接続せず、安全に既存画面だけを提供する', async () => {
  for (const flag of [undefined, 'false']) {
    let payload, status;
    const headers = {};
    const handler = handlerFactory({ONEONONE_ENABLED:flag}, async () => {throw new Error('must not connect');});
    const res = {setHeader(k,v){headers[k]=v;},status(n){status=n;return this;},json(v){payload=v;}};
    await handler({method:'GET',query:{},headers:{}},res);
    assert.equal(status,200); assert.deepEqual(payload,{available:false});
    assert.equal(headers['Cache-Control'],'no-store, private');
  }
});
test('確認済みの通知先が未設定・不正の場合は外部送信しない', async () => {
  const people=JSON.parse(routingEnv.ONEONONE_TEAMS_RECIPIENTS);
  for (const invalid of [{}, {...routingEnv,ONEONONE_TEAMS_MANAGER:'test-manager@copros.co.jp'}, {...routingEnv,ONEONONE_TEAMS_RECIPIENTS:'{'}, {...routingEnv,ONEONONE_TEAMS_RECIPIENTS:JSON.stringify({...people,'extra@shimizu-gumi.net':'追加'})}, {...routingEnv,ONEONONE_TEAMS_RECIPIENTS:JSON.stringify({...people,'test-staff1@shimizu-gumi.net':'<script>'})}]) {
    assert.throws(()=>teamsRouting(invalid),{status:503});
    const env={...invalid,ONEONONE_TEAMS_WEBHOOK:'https://flow.example.invalid',ONEONONE_TEAMS_SECRET:'test',ONEONONE_APP_ORIGIN:'https://app.example.invalid'};
    assert.equal(configuration(env).teams,false);
    await assert.rejects(()=>sendTeams(env,async()=>{throw new Error('must not send');},job,{m365_email:'test-staff1@shimizu-gumi.net'}),{status:503});
  }
});
test('設定済み4名だけへ通知し、任意の氏名や宛先は採用しない', () => {
  const routing=teamsRouting(routingEnv);
  const result=notification(job,{m365_email:'test-staff1@shimizu-gumi.net',name:'untrusted'},'https://app.example.invalid',routing);
  assert.equal(result.recipient,routing.manager); assert.equal(result.memberName,'テスト社員1');
  assert.throws(()=>notification(job,{m365_email:'outsider@shimizu-gumi.net'},'https://app.example.invalid',routing),{status:403});
});
test('コプロスの対象メールボックス未設定・別会社なら予定表へ接続しない', async () => {
  for (const mailbox of [undefined,'test-manager@shimizu-gumi.net']) {
    const env={ONEONONE_COPROS_MAILBOX:mailbox,ONEONONE_COPROS_TENANT_ID:'11111111-1111-4111-8111-111111111111',ONEONONE_COPROS_CLIENT_ID:'test',ONEONONE_COPROS_CLIENT_SECRET:'test',ONEONONE_COPROS_CALENDAR_ID:'test',ONEONONE_CALENDAR_SCOPE_APPROVED:'true'};
    const api=createIntegrations(env,async()=>{throw new Error('must not connect');});
    assert.equal(api.config.calendar,false);
    await assert.rejects(()=>api.availability([]),{status:503});
  }
});
test('内部ソース・設定・社内文書を配信せず、既存の日次同期を維持する', () => {
  const config=require('../vercel.json');
  for (const path of ['/lib/oneonone/teams.js','/dev/oneonone-stub.js','/tests/oneonone-release.test.js','/docs/oneonone-implementation.md','/setup-oneonone.sql','/.env.oneonone.local']) {
    assert(config.routes.some(r=>r.status===404 && r.dest==='/404.html' && new RegExp(`^(?:${r.src})$`).test(path)));
  }
  assert.deepEqual(config.crons,[{path:'/api/mf/sync',schedule:'0 21 * * *'}]);
  for (const path of ['/','/oneonone.js','/oneonone.css','/api/mf/status','/api/oneonone']) {
    assert(!config.routes.some(r=>r.status===404 && new RegExp(`^(?:${r.src})$`).test(path)));
  }
});
