(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneOnOneDomain = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.0';
  const PULSE = [
    ['P01', '総合満足度', '今の会社での働き方全体に満足している。'],
    ['P02', '業務負荷', '今の仕事量は、無理なく続けられる範囲にある。'],
    ['P03', '役割', '自分の役割と、会社から期待されていることが分かっている。'],
    ['P04', '相談', '困りごとや意見を、安心して相談できる。'],
    ['P05', '協力', '仕事を進めるうえで、周囲から必要な協力を得られている。'],
    ['P06', '成長', '自分が望む成長につながる経験ができている。'],
    ['P07', '評価・待遇', '自分の役割や貢献に対する評価・待遇に納得している。'],
    ['P08', '継続勤務', '今後6か月も、この会社で働き続けたいと思っている。']
  ];
  const SCALE = ['', '1 全くそう思わない', '2 あまりそう思わない', '3 どちらともいえない', '4 そう思う', '5 とてもそう思う'];
  const INTENTS = ['現在の仕事を続けるための支援', '役割・働き方・待遇の見直し', '社外も含めたキャリアの検討', '退職・異動について相談したい', '今回は特にない', '回答を控える'];
  const copy = value => JSON.parse(JSON.stringify(value));
  function fail(message) { const e = new Error(message); e.status = 400; throw e; }
  function str(v, max = 500) { if (v == null) return ''; if (typeof v !== 'string' || v.length > max) fail(`入力は${max}文字以内でお願いします。`); return v.trim(); }
  function date(v) { const s = str(v, 10); if (s && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(new Date(s).getTime()) || new Date(s).toISOString().slice(0, 10) !== s)) fail('日付を確認してください。'); return s; }
  function number(v, max) { if (v === '' || v == null) return ''; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) fail('数値の範囲を確認してください。'); return n; }
  function rows(v, fields, max=3) { if (!Array.isArray(v) || v.length > max) fail(`各項目は${max}件までです。`); return v.map(r => Object.fromEntries(Object.entries(fields).map(([k, type]) => [k, type === 'date' ? date(r[k]) : typeof type === 'number' ? number(r[k], type) : str(r[k], type === 'long' ? 1000 : 300)]))); }
  function cycleFor(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit'}).formatToParts(now);
    let y = Number(parts.find(p => p.type === 'year').value), m = Number(parts.find(p => p.type === 'month').value);
    let n = Math.max(2026 * 12 + 9, y * 12 + m - 1); if ((n - (2026 * 12 + 9)) % 2) n++;
    return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
  }
  function shiftCycle(id, delta) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(id)) fail('実施回が不正です。'); const d = new Date(`${id}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); }
  function period(id) { return {from: `${shiftCycle(id, -2)}-01`, to: new Date(new Date(`${id}-01T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)}; }
  function emptyDraft() { return {schema: VERSION, topic: '', support: '', pulse: {}, pulseReason: '', intents: [], request: '', review: {good: '', difficult: '', learning: ''}, contributions: [{target: '', action: '', volume: '', unit: '', due: '', expected: '', evidence: ''}], time: [{work: '', hours: '', necessity: '', decision: '維持', plan: ''}], issues: [], growth: [{skill: '', meaning: '', value: '', support: ''}], career: {values: '', strengths: '', experience: ''}, goal: {text: '', due: '', evidence: '', support: '', changeReason: ''}, actions: [{text: '', due: '', metric: '', support: '', experiment: ''}], candidates: ['', '', ''], consent: false}; }
  function sanitizeDraft(input, submit = false, now = new Date()) {
    if (!input || typeof input !== 'object') fail('入力内容を確認してください。');
    const b = emptyDraft();
    for (const k of ['topic', 'support', 'pulseReason', 'request']) b[k] = str(input[k]);
    for (const [id] of PULSE) { const v = input.pulse?.[id]; if (v == null || v === '') continue; if (![1, 2, 3, 4, 5, 'na', 'decline'].includes(v)) fail('状態の回答が不正です。'); b.pulse[id] = v; }
    if (!Array.isArray(input.intents) || input.intents.some(v => !INTENTS.includes(v))) fail('相談項目が不正です。');
    b.intents = [...new Set(input.intents)];
    if (b.intents.some(v => INTENTS.indexOf(v) >= 4) && b.intents.length > 1) fail('「特になし」「回答を控える」は単独で選んでください。');
    for (const k of Object.keys(b.review)) b.review[k] = str(input.review?.[k]);
    b.contributions = rows(input.contributions, {target: '', action: '', volume: 1000000, unit: '', due: 'date', expected: 1e12, evidence: ''});
    b.time = rows(input.time, {work: '', hours: 168, necessity: '', decision: '', plan: ''});
    if (b.time.reduce((a, r) => a + Number(r.hours), 0) > 168) fail('週の時間合計は168時間以内にしてください。');
    if (b.time.some(r => !['維持', 'やめる', '減らす', '任せる'].includes(r.decision))) fail('仕事の見直し方法を選んでください。');
    b.issues = rows(input.issues, {event: '', impact: '', proposal: '', request: ''});
    b.growth = rows(input.growth, {skill: '', meaning: '', value: '', support: ''});
    for (const k of Object.keys(b.career)) b.career[k] = str(input.career?.[k]);
    for (const k of Object.keys(b.goal)) b.goal[k] = k === 'due' ? date(input.goal?.[k]) : str(input.goal?.[k]);
    b.actions = rows(input.actions, {text: '', due: 'date', metric: '', support: '', experiment: ''});
    if (!Array.isArray(input.candidates) || input.candidates.length !== 3) fail('候補日時を3件入力してください。');
    b.candidates = input.candidates.map(v => { if (!v) return ''; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) fail('候補日時を確認してください。'); const instant=new Date(v + ':00+09:00'); if(!Number.isFinite(instant.getTime()) || new Date(instant.getTime()+32400000).toISOString().slice(0,16)!==v)fail('候補日時を確認してください。'); return v; });
    b.consent = input.consent === true;
    if (submit) {
      if (!b.consent) fail('利用目的・閲覧範囲の確認が必要です。');
      if (!b.topic) fail('最初に話したいことを記入してください。「特になし」でも構いません。');
      if (b.candidates.some(v => !v || new Date(v + ':00+09:00') <= now) || new Set(b.candidates).size !== 3) fail('未来の異なる候補日時を3件入力してください。');
      const times = b.candidates.map(v => new Date(v + ':00+09:00').getTime()).sort();
      if (times.some((v, i) => i && v - times[i - 1] < 1800000)) fail('30分の候補枠が重ならないようにしてください。');
    }
    return b;
  }
  function trends(current, previous) {
    return PULSE.map(([id, name]) => { const value = current?.body?.pulse?.[id]; const comparable = previous && current.schema === previous.schema && previous.cycle === shiftCycle(current.cycle, -2); const before = comparable ? previous.body.pulse?.[id] : undefined; const delta = typeof value === 'number' && typeof before === 'number' ? value - before : null; return {id, name, value: value ?? null, before: before ?? null, delta, attention: typeof value === 'number' && (value <= 2 || delta !== null && delta <= -2)}; });
  }
  function sheet(current, previous) {
    const b = current.body;
    return {source: '定型', version: VERSION, submissionId: current.id, questions: [
      {text: `「${b.topic || '今回話したいこと'}」について、今日一つ決められるとしたら何ですか？`, source: 'topic'},
      ...trends(current, previous).filter(r => r.attention).slice(0, 2).map(r => ({text: `${r.name}の回答について、どのような場面が影響していますか。会社にできる支援はありますか？`, source: r.id})),
      {text: '前回の会社側の支援は届きましたか。次回までに試したいことを一つ決めましょう。', source: 'actions'}
    ].slice(0, 3), summary: b.topic || '面談で相談事項を確認', reviewed: false};
  }
  // 支援情報は評価ペイロードに渡さず、明示的に許可した業務事実だけを採用する。
  function evaluationFacts(submission, metrics) {
    const b = submission.body;
    return {submissionId: submission.id, cycle: submission.cycle, contributions: copy(b.contributions), growth: b.growth.map(r => ({skill: r.skill, value: r.value})), goal: {text: b.goal.text, due: b.goal.due, evidence: b.goal.evidence}, metrics: copy(metrics)};
  }
  function metrics(cases, aliases, cycle) {
    const p = period(cycle), sources = []; let sales = 0, flight = 0, paymentStatusAmount = 0;
    const inside = d => typeof d === 'string' && d.slice(0, 10) >= p.from && d.slice(0, 10) <= p.to;
    for (const row of cases) {
      const c = row.data || row, amount = parseFloat(c.orderAmount) || 0;
      if (c.status === '失注' || c.deletedAt || amount <= 0) continue;
      const owned = aliases.includes(c.salesOwner || c.owner || '');
      const assignments = [1, 2, 3].map(n => ({name: c[n === 1 ? 'flightOwner' : `flightOwner${n}`], ratio: Math.max(0, parseFloat(c[`flightRatio${n}`]) || 0)})).filter(r => r.name);
      const total = assignments.reduce((a, r) => a + r.ratio, 0);
      const share = assignments.filter(r => aliases.includes(r.name)).reduce((a, r) => a + (total ? r.ratio / total : 1 / assignments.length), 0);
      let used = false;
      if (inside(c.orderDate)) { if (owned) { sales += amount; used = true; } if (share) { flight += amount * share; used = true; } }
      if (owned && c.billingStatus === '入金済' && inside(c.paymentDate)) { paymentStatusAmount += amount; used = true; }
      if (used) sources.push({id: row.id, amount, orderDate: c.orderDate || '', paymentDate: c.paymentDate || '', owner: c.salesOwner || c.owner || '', share, billingStatus: c.billingStatus || ''});
    }
    return {version: VERSION, period: p, retrievedAt: new Date().toISOString(), sales, flight: Math.round(flight), paymentStatusAmount, sources};
  }
  function sharedRecord(input) {
    const result = {summary: str(input.summary, 1000), actions: rows(input.actions, {kind:'',text: '', owner: '', due: 'date', metric: '', status: '', result: ''},6)};
    result.actions.forEach(r=>{if(!r.kind)r.kind='本人の行動';if(!['本人の行動','会社の支援'].includes(r.kind))fail('合意事項の種別を選んでください。');});
    for(const kind of ['本人の行動','会社の支援'])if(result.actions.filter(r=>r.kind===kind).length>3)fail('本人の行動・会社の支援はそれぞれ3件までです。');
    if (!result.actions.length || result.actions.some(r => !r.text || !r.owner || !r.due || !r.metric || !['未着手', '進行中', '完了', '見直し', '中止'].includes(r.status))) fail('合意事項には担当者・期限・完了条件を入力してください。');
    return result;
  }
  return {VERSION, PULSE, SCALE, INTENTS, copy, fail, str, date, cycleFor, shiftCycle, period, emptyDraft, sanitizeDraft, trends, sheet, evaluationFacts, metrics, sharedRecord};
});
