(function () {
  'use strict';
  const D = window.OneOnOneDomain;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  let client, root, state, selected, detail, cycle, stage = 0, pane = 'prepare', editing = false, draft, dirty = false, managerDirty = false, saveTimer, saving, busy = false, generation = 0, message = '', messageType = '', sessionSubscription;
  const stateNames = {pending: '処理待ち', processing: '処理中', confirmed: '日程確定', cancelled: '取消済み', conflict: '日程の再選択が必要', sent: '完了', failed: '連携失敗', unknown: '結果未確認', not_configured: '連携未設定'};
  const manager = () => state?.actor.role === 'manager';
  const button = (action, label, primary = false, attrs = '') => `<button type="button" class="oo-button${primary ? ' primary' : ''}" data-oo="${action}" ${attrs}>${label}</button>`;
  const icon = (action, label, symbol, attrs = '') => `<button type="button" class="oo-button oo-icon" data-oo="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${symbol}</button>`;
  const badge = (label, tone = '') => `<span class="oo-badge ${tone}">${esc(label)}</span>`;
  const text = value => `<div class="oo-text">${esc(value || '記入なし')}</div>`;
  const labelValue = v => v == null || v === '' ? '未回答' : v === 'na' ? '該当なし' : v === 'decline' ? '回答を控える' : v;
  const stamp = s => s ? new Date(s).toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
  const slot = s => s ? `${s.slice(0, 10).replaceAll('-', '/')} ${s.slice(11)}〜${new Date(new Date(s + ':00+09:00').getTime() + 1800000).toLocaleTimeString('ja-JP', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'})}` : '未確定';
  const memberName = id => state.members.find(m => m.user_id === id)?.name || state.actor.name;
  const sourceLabel = id => ({topic:'本人のテーマ',support:'支援希望',request:'会社への要望',review:'振り返り',growth:'成長',career:'強み・価値観',actions:'次の行動'}[id] || D.PULSE.find(p=>p[0]===id)?.[1] || '提出原文');
  const at = (obj, path) => path.split('.').reduce((a, k) => a?.[k], obj);
  function set(obj, path, value) { const keys = path.split('.'); let target = obj; keys.slice(0, -1).forEach(k => { target = target[k]; }); target[keys.at(-1)] = value; }
  async function api(action, body, query = {}) {
    const epoch = generation;
    const {data: {session}} = await client.auth.getSession();
    if (!session) { clear(); throw new Error('ログインし直してください。'); }
    const res = await fetch(`/api/oneonone?${new URLSearchParams({action, ...query})}`, {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${session.access_token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'});
    const out = await res.json();
    if (epoch !== generation) throw new Error('ログイン状態が変更されました。');
    if (!res.ok) { const err = new Error(out.error || '処理を完了できません。'); err.status = res.status; if (res.status === 401 || res.status === 403) clear(); throw err; }
    if (out.available === false) throw new Error('1on1は現在準備中です。');
    return out;
  }
  function show(messageText, type = '') { message = messageText; messageType = type; const el = root?.querySelector('#ooMessage'); if (el) { el.className = `oo-banner ${type}`; el.textContent = message; el.hidden = !message; } else if(root && message){root.innerHTML=`<div class="oo-banner error" role="alert">${esc(message)}</div>`;} }
  function confirmAction(messageText) {
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='oo-confirm';
      dialog.innerHTML=`<h2>操作の確認</h2><p>${esc(messageText)}</p><div class="oo-actions"><button type="button" class="oo-button" data-answer="no">キャンセル</button><button type="button" class="oo-button primary" data-answer="yes">実行する</button></div>`;
      const finish=value=>{dialog.close();dialog.remove();resolve(value);};
      dialog.addEventListener('cancel',e=>{e.preventDefault();finish(false);});
      dialog.addEventListener('click',e=>{const answer=e.target.closest('[data-answer]');if(answer)finish(answer.dataset.answer==='yes');});
      document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-answer="no"]').focus();
    });
  }
  async function attach(sb) {
    clear(); client = sb; root = document.getElementById('oneononeRoot'); const epoch = generation;
    if (!root) return;
    root.onclick = onClick; root.oninput = onInput; root.onchange = onChange;
    try {
      const out = await api('bootstrap'); if (epoch !== generation) return;
      state = out; cycle = out.cycle;
      document.querySelector('[data-tab=oneonone]').hidden = false;
      const deep = new URLSearchParams(location.search).get('oneonone');
      selected = out.records.find(r => r.id === deep)?.id || out.records.find(r => r.cycle === cycle)?.id;
      if (deep && selected === deep) { cycle = out.records.find(r => r.id === deep).cycle; await window.switchTab('oneonone'); }
    } catch (e) { if (epoch === generation && root) root.innerHTML = `<div class="oo-empty">${esc(e.message)}</div>`; }
    if (client?.auth.onAuthStateChange) sessionSubscription = client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') clear(); }).data?.subscription;
  }
  function clear() {
    generation++; clearTimeout(saveTimer); sessionSubscription?.unsubscribe(); sessionSubscription = null;
    state = detail = draft = selected = null; dirty = false; managerDirty = false; editing = false; pane = 'prepare'; message = '';
    if (root) root.innerHTML = '';
    const nav = document.querySelector('[data-tab=oneonone]'); if (nav) nav.hidden = true;
    document.querySelector('.oo-print')?.remove();document.querySelector('.oo-print-toolbar')?.remove(); document.body.classList.remove('oo-printing');
  }
  async function navigate(tab) {
    if (managerDirty && !await confirmAction('保存していない入力があります。破棄して画面を移動しますか？')) throw new Error('保存後に画面を移動してください。');
    managerDirty=false;
    document.body.classList.toggle('oo-active', tab === 'oneonone');
    if (tab !== 'oneonone') { if (dirty) await save(); managerDirty = false; return; }
    if (!state) return;
    const entering = !document.querySelector('[data-section="oneonone"]')?.classList.contains('active');
    if (!detail && selected) await load(selected); else render();
    if(entering)requestAnimationFrame(()=>root?.scrollIntoView({block:'start'}));
  }
  async function load(id) {
    if (dirty) await save();
    const epoch = generation; const data = await api('detail', undefined, {id}); if (epoch !== generation) return;
    selected = id; detail = data; draft = D.copy(Object.keys(data.record.draft || {}).length ? data.record.draft : D.emptyDraft());
    editing = !manager() && !data.current;
    if (!data.current && !Object.keys(data.record.draft || {}).length && data.history?.length) {
      const previous = data.history[0].body;
      draft.goal = D.copy(previous.goal); draft.career = D.copy(previous.career);
    }
    dirty = false; managerDirty = false; render();
  }
  function render() {
    if (!root || !state) return;
    const records = state.records.filter(r => r.cycle === cycle), p = D.period(cycle);
    const submitted = records.filter(r => r.submitted_version).length, complete = records.filter(r => r.shared?.publishedAt).length;
    root.innerHTML = `<div class="oo-head"><div class="oo-title"><h1>1on1</h1>${badge(manager() ? '面談担当者' : '自分の面談')}<span class="oo-muted">隔月・30分</span></div><div class="oo-toolbar"><label for="ooCycle" class="oo-muted">実施回</label><select id="ooCycle" style="width:140px">${state.cycles.map(c => `<option value="${c.id}" ${c.id === cycle ? 'selected' : ''}>${c.id.replace('-', '年')}月</option>`).join('')}</select>${icon('refresh', '最新の状態を取得', '↻')}</div></div>
      <div id="ooMessage" class="oo-banner ${messageType}" role="status" aria-live="polite" ${message ? '' : 'hidden'}>${esc(message)}</div>
      ${manager() ? `<div class="oo-statline"><span><strong>${submitted}/${records.length}</strong> 提出済み</span><span><strong>${complete}</strong> 合意共有済み</span><span>振り返り ${p.from}〜${p.to}</span><span>${state.cycles.find(c => c.id === cycle)?.deadline ? `提出期限 ${state.cycles.find(c => c.id === cycle).deadline}` : '提出期限 未設定'}</span></div><div class="oo-layout"><aside class="oo-people" aria-label="面談対象者">${records.map(r => `<button class="oo-person" data-oo="select" data-id="${r.id}" aria-current="${r.id === selected}"><span class="oo-person-name">${esc(memberName(r.user_id))}</span>${status(r)}${r.consultation?.status === 'requested' ? badge('個別相談あり', 'gold') : ''}</button>`).join('')}<div class="oo-section">${button('next-cycle', '次回を準備')}<div class="oo-muted" style="margin-top:12px">${configurationText()}</div></div></aside><div class="oo-panel">${managerDetail()}</div></div>` : `<div class="oo-employee"><div class="oo-statline"><span>${esc(state.actor.name)}</span><span>振り返り ${p.from}〜${p.to}</span>${detail ? status(detail.record) : ''}</div><div class="oo-panel">${employeeDetail()}</div></div>`}`;
    if(manager())root.querySelector('.oo-head .oo-toolbar').insertAdjacentHTML('beforeend',button('cycle-settings','記入期間を設定'));
    if(detail && !manager() && !editing && pane!=='answers')root.querySelector('.oo-panel').insertAdjacentHTML('beforeend',employeeProgress());
    if(detail && manager() && pane==='shared')root.querySelector('.oo-panel').insertAdjacentHTML('beforeend',progressRead());
    if(detail?.sheet?.source==='AI' && manager() && pane==='prepare') {
      const s=detail.sheet;
      root.querySelector('.oo-panel .oo-section').insertAdjacentHTML('beforeend',`<div class="oo-banner"><h3>AI要約・要確認</h3>${text(s.summary)}<p class="oo-muted">根拠：「${esc(s.summaryEvidence.quote)}」</p>${(s.changes||[]).map(c=>`<div class="oo-question">${text(c.text)}<small>前回「${esc(c.previousQuote)}」 → 今回「${esc(c.quote)}」</small></div>`).join('')}</div>`);
    }
    if(!manager() && state.alternateContact)root.querySelector('.oo-panel').insertAdjacentHTML('beforeend',`<section class="oo-section"><h3>別の窓口へ相談したいとき</h3>${text(state.alternateContact)}</section>`);
    if (busy) root.querySelectorAll('[data-oo]').forEach(b => b.disabled = true);
  }
  function configurationText() { return `Teams個人チャット ${state.config.teams ? '設定あり' : '未設定'}<br>予定表 ${state.config.calendar ? '設定あり' : '未設定'}<br>AI ${state.config.ai ? '設定あり' : '未設定'}${state.config.teamsFlowUrl ? `<br><a href="${esc(state.config.teamsFlowUrl)}" target="_blank" rel="noopener noreferrer">Teams配信履歴を確認</a>` : ''}`; }
  function status(r) { if (r.shared?.publishedAt) return badge('合意共有済み', 'green'); if (r.meeting?.status === 'confirmed') return badge('日程確定', 'green'); if (r.submitted_version) return badge('提出済み', 'gold'); return badge('未提出'); }
  function jobs() { return `<div class="oo-jobs">${(detail.jobs || []).slice(0, 4).map(j => `<span class="oo-muted">${j.kind === 'teams' ? 'Teams個人チャット' : '予定表'}：${j.result?.accepted ? '受付済み・配信未確認' : stateNames[j.state] || j.state}${!j.result?.accepted && ['pending', 'unknown', 'failed', 'not_configured'].includes(j.state) ? button('retry', j.state === 'pending' ? '実行' : '再確認・再実行', false, `data-id="${j.id}"`) : ''}</span>`).join('')}</div>`; }
  function managerDetail() {
    if (!detail || detail.record.id !== selected) return '<div class="oo-empty">対象者を選んでください。</div>';
    const r = detail.record;
    return `<div class="oo-detail-head"><div><h2>${esc(memberName(r.user_id))}</h2><span class="oo-muted">${detail.current ? `提出 v${detail.current.version}・${stamp(detail.current.created_at)}` : '資料の提出待ち'}</span></div>${status(r)}</div>${r.consultation?.status === 'requested' ? `<div class="oo-banner">定期面談を待たずに相談したいとの依頼があります。${button('consult_done', '対応済みにする')}</div>` : ''}${jobs()}<div class="oo-tabs" role="tablist">${[['prepare','面談準備'],['answers','提出資料'],['shared','合意事項'],['evaluation','業績評価']].map(([key, name]) => `<button class="oo-tab" role="tab" aria-selected="${pane === key}" data-oo="pane" data-pane="${key}">${name}</button>`).join('')}</div>${pane === 'prepare' ? prepare() : pane === 'answers' ? answers() : pane === 'shared' ? sharedEditor() : evaluation()}`;
  }
  function prepare() {
    const r = detail.record, s = detail.sheet;
    if (!s) return `<div class="oo-empty">提出後に面談資料と質問案が表示されます。<br>本人の下書きは閲覧できません。</div>${privateNote()}`;
    const trends = detail.trends;
    return `<section class="oo-section"><div class="oo-toolbar" style="justify-content:space-between"><h3>最初に話したいこと</h3><div class="oo-toolbar">${button('generate', '質問案を生成')}${button('print', '面談シートを印刷')}</div></div><div class="oo-subject">${esc(detail.current.body.topic)}</div><div class="oo-agenda">${[['3','近況'],['7','本人のテーマ'],['6','成果・障害'],['8','成長・支援'],['6','行動の合意']].map(([m,t]) => `<span><b>${m}分</b>${t}</span>`).join('')}</div></section>
      <section class="oo-section"><h3>日程調整</h3><div class="oo-toolbar">${badge(stateNames[r.meeting?.status] || '日程未確定', r.meeting.status === 'confirmed' ? 'green' : '')}<span>${esc(slot(r.meeting?.start))}</span></div>${r.meeting.reason ? `<div class="oo-banner">${esc(r.meeting.reason)}</div>` : ''}<div class="oo-muted" style="margin:10px 0">主催者：${esc(state.config.calendarAccount || 'コプロス予定表・未設定')}</div><div class="oo-grid">${detail.current.body.candidates.map(start => button('schedule', esc(slot(start)), false, `data-start="${esc(start)}"`)).join('')}</div><div class="oo-actions">${button('availability','空き状況を確認')}${button('resuggest','候補の再提示を依頼')}${r.meeting.eventId ? button('cancel','予定を取り消す') : ''}</div><div id="ooAvailability" class="oo-muted" aria-live="polite"></div></section>
      <section class="oo-section"><h3>状態の変化</h3><div class="oo-table-wrap"><table class="oo-table"><thead><tr><th>項目</th><th>前回</th><th>今回</th><th>差</th><th>面談での確認</th></tr></thead><tbody>${trends.map(t => `<tr class="${t.attention ? 'oo-attention' : ''}"><td>${t.name}</td><td class="num">${labelValue(t.before)}</td><td class="num">${labelValue(t.value)}</td><td class="num">${t.delta === null ? '比較なし' : t.delta > 0 ? '+' + t.delta : t.delta}</td><td>${t.attention ? '変化の背景と必要な支援' : '—'}</td></tr>`).join('')}</tbody></table></div><p class="oo-muted" style="margin-top:12px">自己回答の変化です。離職の予測や人事評価の点数ではありません。</p>${historyTrends()}</section>
      <section class="oo-section"><div class="oo-toolbar" style="justify-content:space-between"><h3>確認したい質問</h3>${badge(s.source === 'AI' ? 'AI案・要確認' : '定型案')}${s.reviewed ? badge('確認済み','green') : detail.private.sheet ? button('review_sheet','内容を確認済みにする') : ''}</div>${s.notice ? `<p class="oo-muted">${esc(s.notice)}</p>` : ''}${s.questions.map((q,i) => `<div class="oo-question"><b>${i+1}.</b> ${esc(q.text)}<small>根拠：${esc(sourceLabel(q.source))}${q.quote ? `「${esc(q.quote)}」` : ''}</small></div>`).join('')}</section>${pastActions()}${privateNote()}`;
  }
  function historyTrends() {
    const history = [detail.current, ...detail.history].filter((s, i, arr) => arr.findIndex(x => x.cycle === s.cycle) === i).slice(0,6).reverse();
    if (history.length < 2) return '';
    return `<details style="margin-top:16px"><summary>過去${history.length}回の回答</summary><div class="oo-table-wrap"><table class="oo-table"><thead><tr><th>項目</th>${history.map(h => `<th>${h.cycle}</th>`).join('')}</tr></thead><tbody>${D.PULSE.map(([id,name]) => `<tr><td>${name}</td>${history.map(h => `<td>${labelValue(h.body.pulse[id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  }
  function privateNote() { return `<section class="oo-section"><h3>面談担当者のメモ</h3><label class="oo-field">本人には共有されません<textarea id="ooPrivateNote" maxlength="3000" rows="4">${esc(detail.private?.note || '')}</textarea></label><div class="oo-actions">${button('note','メモを保存')}</div></section>`; }
  function pastActions() {
    const list = detail.pastRecords.flatMap(r => (r.shared?.actions || []).filter(a => !['完了','中止'].includes(a.status)).map(a => ({...a, cycle:r.cycle})));
    return `<section class="oo-section"><h3>前回までの行動・会社の支援</h3>${list.length ? list.map(a => `<div class="oo-question">${badge(a.status)} <b>${esc(a.text)}</b><div class="oo-muted">${esc(a.owner)}・期限 ${esc(a.due)}・${a.cycle}回</div>${text(a.result)}</div>`).join('') : '<p class="oo-muted">未完了の合意事項はありません。</p>'}</section>`;
  }
  function answers(submission = detail.current) {
    if (!submission) return '<div class="oo-empty">提出資料はまだありません。</div>';
    const b = submission.body;
    return `<div class="oo-toolbar"><label for="ooVersion" class="oo-muted">提出版・過去の資料</label><select id="ooVersion" style="max-width:300px">${[...detail.versions, ...detail.history].map(v => `<option value="${v.id}" ${v.id === submission.id ? 'selected' : ''}>${v.cycle}・v${v.version}・${stamp(v.created_at)}</option>`).join('')}</select></div><section class="oo-section"><h3>最初に話したいこと</h3>${text(b.topic)}<h3 style="margin-top:16px">希望する支援</h3>${text(b.support)}</section><section class="oo-section"><h3>状態の自己回答</h3><div class="oo-table-wrap"><table class="oo-table"><tbody>${D.PULSE.map(([id,name]) => `<tr><th>${name}</th><td>${labelValue(b.pulse[id])}</td></tr>`).join('')}</tbody></table></div>${text(b.pulseReason)}${text(b.intents.join('、'))}</section>${[['振り返り', b.review], ['半年後の目標', b.goal], ['大切にしたいこと・強み', b.career]].map(([title,obj]) => `<section class="oo-section"><h3>${title}</h3>${objectText(obj)}</section>`).join('')}${[['貢献施策',b.contributions],['時間を使う仕事',b.time],['課題と改善案',b.issues],['伸ばしたい力',b.growth],['次回までの行動案',b.actions]].map(([title,rs]) => `<section class="oo-section"><h3>${title}</h3>${rs.map(objectText).join('<hr style="border:0;border-top:1px solid #dce2e6;margin:16px 0">') || '記入なし'}</section>`).join('')}<section class="oo-section"><h3>会社・面談担当者・他メンバーへの要望</h3>${text(b.request)}</section>`;
  }
  const names = {kind:'種別',good:'良かったこと',difficult:'うまくいかなかったこと',learning:'学び',text:'目標・行動',due:'期限',evidence:'成果・実績の根拠',support:'必要な支援',changeReason:'見直し理由',values:'大切にしたいこと',strengths:'自分の強み',experience:'経験したい仕事',target:'誰に',action:'何をするか',volume:'行動量',unit:'単位',expected:'見込売上（円）',work:'仕事',hours:'平均週時間',necessity:'必要性',decision:'見直し',plan:'対応案',event:'具体的な出来事',impact:'業務への影響',proposal:'改善案',request:'会社への依頼',skill:'伸ばしたい力',meaning:'自分にとっての意味',value:'事業に生む価値',metric:'完了条件',experiment:'小さく試す一歩',owner:'担当者',status:'進捗',result:'結果・障害',supportReceived:'支援の受け取り'};
  function objectText(obj) { return `<div class="oo-text">${Object.entries(obj || {}).filter(([,v]) => v !== '').map(([k,v]) => `<b>${esc(names[k] || k)}</b>　${esc(v)}`).join('<br>') || '記入なし'}</div>`; }
  function field(path, label, type = 'text', options, valueObject = draft) {
    const value = at(valueObject, path) ?? '', name = `oo-${path.replaceAll('.','-')}`;
    const data = `data-path="${path}" id="${name}"`;
    const control = type === 'textarea' ? `<textarea ${data} maxlength="500" rows="3">${esc(value)}</textarea>` : type === 'select' ? `<select ${data}>${options.map(o => { const [v,l] = Array.isArray(o) ? o : [o,o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>` : `<input ${data} type="${type}" value="${esc(value)}" ${type === 'number' ? 'min="0" step="any"' : type === 'text' ? 'maxlength="300"' : ''}>`;
    return `<label class="oo-field${type === 'textarea' ? ' wide' : ''}" for="${name}">${esc(label)}${control}</label>`;
  }
  const definitions = {contributions: [['target','誰に'],['action','何をするか'],['volume','行動量','number'],['unit','単位'],['due','期限','date'],['expected','見込売上（円）','number'],['evidence','目標・実績の根拠']], time:[['work','仕事'],['hours','平均週時間','number'],['necessity','必要性'],['decision','見直し','select',['維持','やめる','減らす','任せる']],['plan','対応案']], issues:[['event','具体的な出来事'],['impact','業務への影響'],['proposal','改善案'],['request','会社への依頼']], growth:[['skill','伸ばしたい力'],['meaning','自分にとっての意味'],['value','事業・顧客に生む価値'],['support','必要な経験・支援']], actions:[['text','行動'],['due','期限','date'],['metric','成果指標・完了条件'],['support','会社に求める支援'],['experiment','小さく試す最初の一歩']]};
  function repeater(key, title) { return `<section class="oo-section"><h3>${title}</h3>${draft[key].map((r,i) => `<div class="oo-repeater"><div class="oo-repeater-head"><b>${i+1}</b>${icon('remove-row','この項目を削除','×',`data-key="${key}" data-index="${i}"`)}</div><div class="oo-grid">${definitions[key].map(([k,l,t,o]) => field(`${key}.${i}.${k}`,l,t,o)).join('')}</div></div>`).join('')}${draft[key].length < 3 ? button('add-row','＋ 追加',false,`data-key="${key}"`) : ''}</section>`; }
  function employeeDetail() {
    if (!detail) return '<div class="oo-empty">実施回を準備しています。</div>';
    const r = detail.record;
    return `<div class="oo-toolbar" style="justify-content:space-between"><span>${badge(stateNames[r.meeting.status] || '日程未確定', r.meeting.status === 'confirmed' ? 'green' : '')} ${esc(slot(r.meeting.start))}</span>${r.consultation?.status === 'requested' ? badge('個別相談を依頼済み','gold') : button('consult','次回を待たずに相談')}</div>${r.meeting.resuggest ? '<div class="oo-banner">候補日時の再提示をお願いします。回答を修正して、再提出してください。</div>' : ''}${editing ? employeeForm() : `<div class="oo-actions">${button('edit','回答を修正')}</div><div class="oo-tabs" role="tablist">${[['prepare','今回の合意事項'],['answers','自分の提出資料']].map(([p,l])=>`<button class="oo-tab" role="tab" data-oo="pane" data-pane="${p}" aria-selected="${pane === p}">${l}</button>`).join('')}</div>${pane === 'answers' ? answers() : sharedRead()}`}`;
  }
  function employeeForm() {
    let html = '';
    if (stage === 0) html = `<section class="oo-section"><h2>今回、話したいこと</h2><div class="oo-grid">${field('topic','最初に話したいこと（特になし・面談で話したい、でも可）','textarea')}${field('support','希望する支援','textarea')}</div></section><section class="oo-section"><h3>直近2か月の状態</h3><p class="oo-muted">各項目は任意です。継続勤務のみ今後6か月についてお答えください。</p>${D.PULSE.map(([id,name,q]) => `<div class="oo-pulse-row"><span><b>${name}</b><br>${q}</span>${field(`pulse.${id}`,name,'select', [['','未選択'],...[1,2,3,4,5].map(n=>[n,D.SCALE[n]]),['na','該当しない'],['decline','回答を控える']])}</div>`).join('')}${field('pulseReason','回答の背景（任意）','textarea')}</section><section class="oo-section"><h3>今後の働き方について相談したいこと</h3>${D.INTENTS.map((v,i)=>`<label class="oo-check"><input type="checkbox" data-intent="${i}" ${draft.intents.includes(v)?'checked':''}>${v}</label>`).join('')}${field('request','会社・面談担当者・他メンバーに改善してほしいこと','textarea')}</section>`;
    if (stage === 1) html = `${pastActions()}<section class="oo-section"><h2>振り返りと仕事</h2><div class="oo-grid">${field('review.good','良かったこと','textarea')}${field('review.difficult','うまくいかなかったこと','textarea')}${field('review.learning','学び','textarea')}</div></section>${repeater('contributions','役割に応じた貢献施策')}${repeater('time','時間を使う仕事（週合計168時間以内）')}${repeater('issues','会社の課題と改善案')}`;
    if (stage === 2) html = `<section class="oo-section"><h2>成長と次の一歩</h2><details><summary>大切にしたいこと・強み（初回や変化があったとき）</summary><div class="oo-grid" style="margin-top:16px">${field('career.values','仕事で大切にしたいこと','textarea')}${field('career.strengths','経験から分かった自分の強み','textarea')}${field('career.experience','経験してみたい仕事・役割','textarea')}</div></details></section>${repeater('growth','もっとできるようになりたいこと')}<section class="oo-section"><h3>半年後の成長目標</h3><div class="oo-grid">${field('goal.text','達成したい状態','textarea')}${field('goal.due','当初の目標日','date')}${field('goal.evidence','達成を確認できる根拠')}${field('goal.support','必要な支援')}${field('goal.changeReason','目標を見直す場合の理由')}</div></section>${repeater('actions','次回までの行動案')}`;
    if (stage === 3) html = `<section class="oo-section"><h2>面談候補と提出</h2><h3>候補日時を3件（各30分・日本時間）</h3><div class="oo-grid three">${[0,1,2].map(i=>field(`candidates.${i}`,`候補${i+1}`,'datetime-local')).join('')}</div></section><section class="oo-section"><h3>利用目的・閲覧範囲</h3><div class="oo-text">下書きは本人のみが閲覧できます。提出した回答は本人と宮﨑さんが閲覧します。比較分析・質問案・評価資料は宮﨑さんのみが閲覧します。
業務成果・行動・成長は人事判断の材料にします。満足度、継続勤務の意向、相談、回答を控えること自体は減点材料にしません。匿名回答ではありません。
${state.config.ai ? '提出内容の一部を、会社が承認したAIサービスで質問案の作成に利用します。' : 'AIへの送信は現在無効です。利用開始時に取り扱いを案内します。'}
保存期間：${esc(state.retention)}</div><label class="oo-check" style="margin-top:18px"><input type="checkbox" data-path="consent" ${draft.consent?'checked':''}>利用目的と閲覧範囲を確認しました</label></section><section class="oo-section"><h3>提出内容の確認</h3><div class="oo-grid"><div><span class="oo-muted">最初に話したいこと</span>${text(draft.topic)}</div><div><span class="oo-muted">半年後の目標</span>${text(draft.goal.text)}</div></div>${Object.keys(draft.pulse).length<8?'<div class="oo-banner">状態の質問に未回答があります。未回答のまま提出できます。</div>':''}</section>`;
    return `<div class="oo-steps" aria-label="記入の段階">${['相談・状態','振り返り・仕事','成長・行動','日程・提出'].map((l,i)=>`<button data-oo="stage" data-stage="${i}" aria-current="${stage===i?'step':'false'}">${i+1} ${l}</button>`).join('')}</div>${html}<div class="oo-form-footer"><span id="ooSaveState" class="oo-muted" aria-live="polite">${dirty?'未保存の変更があります':'保存済み'}</span><div class="oo-toolbar">${button('save','下書き保存')}${stage>0?button('stage','戻る',false,`data-stage="${stage-1}"`):''}${stage<3?button('stage','次へ',true,`data-stage="${stage+1}"`):button('submit',detail.current?'修正版を提出':'提出する',true)}</div></div>`;
  }
  function sharedRead() {
    const s = detail.record.shared;
    if (!s.publishedAt) return `<div class="oo-empty">資料は提出済みです。<br>面談で決めた行動・会社の支援は、面談後にここへ共有されます。</div>${pastActions()}`;
    return `<section class="oo-section"><h3>今回決めたこと</h3>${text(s.summary)}${s.actions.map(objectText).join('<hr style="margin:16px 0">')}<p class="oo-muted">共有 v${s.version}・${stamp(s.publishedAt)}</p></section><section class="oo-section"><h3>合意事項の確認</h3>${s.acknowledgedAt ? badge(s.correction?'訂正を依頼済み':'確認済み','green'):''}<label class="oo-field">訂正したい内容（なければ空欄）<textarea id="ooCorrection" maxlength="500">${esc(s.correction||'')}</textarea></label><div class="oo-actions">${button('acknowledge','確認・訂正依頼を送信',true)}</div></section><section class="oo-section"><h3>面談の振り返り（任意・評価対象外）</h3><div class="oo-grid">${[['heard','話したいことを話せた'],['clear','次の一歩が明確になった'],['helpful','自分にとって役立った']].map(([k,l])=>`<label class="oo-field">${l}<select id="ooFeedback-${k}"><option value="">未回答</option>${[1,2,3,4,5].map(v=>`<option value="${v}" ${detail.record.feedback?.[k]===v?'selected':''}>${D.SCALE[v]}</option>`).join('')}<option value="decline" ${detail.record.feedback?.[k]==='decline'?'selected':''}>回答を控える</option></select></label>`).join('')}<label class="oo-field wide">次の面談に向けた希望<textarea id="ooFeedback-comment" maxlength="500">${esc(detail.record.feedback?.comment||'')}</textarea></label></div><div class="oo-actions">${button('feedback','振り返りを送信')}</div></section>`;
  }
  function sharedEditor() {
    const shared = detail.record.shared;
    const actions = shared.actions?.length ? shared.actions : [{text:'',owner:memberName(detail.record.user_id),due:'',metric:'',status:'未着手',result:'',supportReceived:'未確認'}];
    return `<section class="oo-section"><h3>本人に共有する合意事項</h3>${shared.acknowledgedAt?badge(shared.correction?'訂正依頼あり':'本人確認済み',shared.correction?'gold':'green'):''}${shared.correction?`<div class="oo-banner">${esc(shared.correction)}</div>`:''}<label class="oo-field">今回決めたこと<textarea id="ooSharedSummary" maxlength="1000">${esc(shared.summary||'')}</textarea></label><div id="ooSharedActions">${actions.map(sharedActionRow).join('')}</div>${button('add-shared','＋ 行動・会社の支援を追加')}<div class="oo-actions">${button('share','本人に共有する',true)}</div></section>${detail.record.feedback && Object.keys(detail.record.feedback).length?`<section class="oo-section"><h3>本人の面談後の振り返り（支援用）</h3>${[['heard','話せた'],['clear','次の一歩'],['helpful','役立った']].map(([k,l])=>`<p>${l}：${labelValue(detail.record.feedback[k])}</p>`).join('')}${text(detail.record.feedback.comment)}</section>`:''}${pastActions()}`;
  }
  function sharedActionRow(a,i) { return `<div class="oo-repeater" data-shared-row><div class="oo-repeater-head"><b>合意事項 ${i+1}</b>${icon('remove-shared','合意事項を削除','×')}</div><div class="oo-grid">${['kind','text','owner','due','metric','status','result'].map(k=>`<label class="oo-field">${names[k]}${k==='status'||k==='kind'?`<select data-shared="${k}">${(k==='status'?['未着手','進行中','完了','見直し','中止']:['本人の行動','会社の支援']).map(v=>`<option ${v===a[k]?'selected':''}>${v}</option>`).join('')}</select>`:`<input data-shared="${k}" type="${k==='due'?'date':'text'}" maxlength="300" value="${esc(a[k]||'')}">`}</label>`).join('')}</div></div>`; }
  function employeeProgress(){
    const s=detail.record.shared;if(!s.publishedAt)return '';
    return `<section class="oo-section"><h3>自分の行動・会社の支援の進捗</h3>${s.actions.map((a,i)=>{const p=s.employeeProgress?.[i]||{status:'未着手',supportReceived:'未確認',result:''};return `<div data-progress-row class="oo-repeater"><h3>${esc(a.text)}</h3><div class="oo-grid"><label class="oo-field">自分から見た進捗<select data-progress="status">${['未着手','進行中','完了','見直し','中止'].map(v=>`<option ${v===p.status?'selected':''}>${v}</option>`).join('')}</select></label><label class="oo-field">会社の支援を受けられたか<select data-progress="supportReceived">${['未確認','受けられた','一部','受けられていない'].map(v=>`<option ${v===p.supportReceived?'selected':''}>${v}</option>`).join('')}</select></label><label class="oo-field wide">結果・妨げになっていること<input data-progress="result" value="${esc(p.result)}" maxlength="300"></label></div></div>`;}).join('')}<div class="oo-actions">${button('progress','進捗を保存')}</div></section>`;
  }
  function progressRead(){const s=detail.record.shared;return s.employeeProgress?`<section class="oo-section"><h3>本人からの進捗報告</h3>${s.employeeProgress.map((p,i)=>`<div class="oo-question"><b>${esc(s.actions[i]?.text)}</b>${objectText(p)}</div>`).join('')}</section>`:'';}
  function evaluation() {
    const e = detail.private.evaluations?.at(-1), f=e?.facts, m=f?.metrics;
    return `<section class="oo-section"><div class="oo-toolbar" style="justify-content:space-between"><h3>D-BORDの業績・成長の事実</h3>${detail.current?button('metrics','業績の写しを取得'):''}</div><p class="oo-muted">満足度・継続勤務の意向・相談内容・面談後の振り返りは含めません。</p>${!m?'<div class="oo-empty">対象期間の業績を取得すると、取得時点の記録を保存します。</div>':`<div class="oo-kpis"><div><span class="oo-muted">営業担当の受注額</span><strong>${m.sales.toLocaleString()}円</strong></div><div><span class="oo-muted">フライト担当の按分額</span><strong>${m.flight.toLocaleString()}円</strong></div><div><span class="oo-muted">入金済ステータスの受注額</span><strong>${m.paymentStatusAmount.toLocaleString()}円</strong></div></div><p class="oo-muted">${m.period.from}〜${m.period.to}・取得 ${stamp(m.retrievedAt)}・集計定義 v${m.version}<br>営業額とフライト按分額は同じ受注の別の見方です。合算しません。入金の集計日はD-BORDの入金予定日です。</p><details style="margin:16px 0"><summary>業務・成長の根拠と元案件（${m.sources.length}件）</summary>${f.contributions.map(objectText).join('<br>')}${f.growth.map(objectText).join('<br>')}${objectText(f.goal)}<div class="oo-table-wrap"><table class="oo-table"><thead><tr><th>案件ID</th><th>受注額</th><th>受注日</th><th>按分率</th></tr></thead><tbody>${m.sources.map(s=>`<tr><td>${esc(s.id)}</td><td>${s.amount.toLocaleString()}</td><td>${esc(s.orderDate)}</td><td>${Math.round(s.share*100)}%</td></tr>`).join('')}</tbody></table></div></details>`}</section>${e?`<section class="oo-section"><h3>宮﨑さんの判断記録</h3><label class="oo-field">業務事実に基づく判断・理由<textarea id="ooDecision" maxlength="2000" rows="4"></textarea></label><div class="oo-actions">${button('evaluate','判断を記録')}</div>${(detail.private.decisions||[]).slice().reverse().map(d=>`<div class="oo-question"><span class="oo-muted">${stamp(d.at)}</span>${text(d.text)}</div>`).join('')}</section>`:''}`;
  }
  async function save() {
    clearTimeout(saveTimer);
    if (saving) await saving;
    if (!dirty || !draft || manager()) return;
    const data = D.copy(draft), epoch=generation;
    const indicator=root.querySelector('#ooSaveState'); if(indicator)indicator.textContent='保存中…';
    saving=(async()=>{
      const response=await api('draft',{id:selected,revision:detail.record.revision,body:data});
      if(epoch!==generation)return;
      detail.record.revision=response.revision; detail.record.draft=data;
      dirty=JSON.stringify(data)!==JSON.stringify(draft);
      const label=root.querySelector('#ooSaveState'); if(label)label.textContent=dirty?'未保存の変更があります':'保存済み';
    })();
    try{await saving;}catch(e){const label=root?.querySelector('#ooSaveState');if(label)label.textContent='未保存・下書き保存で再試行';throw e;}finally{saving=null;}
  }
  function onInput(e) {
    if (e.target.matches('#ooPrivateNote,#ooDecision,#ooSharedSummary,[data-shared],[data-progress],#ooCorrection,[id^="ooFeedback-"]')) managerDirty = true;
    if(!editing||manager()||!e.target.dataset.path)return;
    const p=e.target.dataset.path;let value=e.target.type==='checkbox'?e.target.checked:e.target.value;
    if(p.startsWith('pulse.'))value=/^[1-5]$/.test(value)?Number(value):value;
    set(draft,p,value);dirty=true;const label=root.querySelector('#ooSaveState');if(label)label.textContent='未保存の変更があります';
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(e=>show(e.message,'error')),900);
  }
  async function onChange(e) {
    try{
      if(e.target.id==='ooCycle'){if(managerDirty && !await confirmAction('未保存の入力を破棄して実施回を切り替えますか？')){e.target.value=cycle;return;}await save();managerDirty=false;cycle=e.target.value;selected=state.records.find(r=>r.cycle===cycle)?.id;detail=null;if(selected)await load(selected);else render();}
      if(e.target.id==='ooVersion'){const v=[...detail.versions,...detail.history].find(v=>v.id===e.target.value);const panel=e.target.closest('.oo-panel');const tabEnd=panel.querySelector('.oo-tabs');let node=tabEnd.nextElementSibling;while(node){const next=node.nextElementSibling;node.remove();node=next;}tabEnd.insertAdjacentHTML('afterend',answers(v));}
      if(e.target.dataset.intent!==undefined){const v=D.INTENTS[Number(e.target.dataset.intent)];if(e.target.checked){draft.intents=D.INTENTS.indexOf(v)>=4?[v]:[...draft.intents.filter(x=>D.INTENTS.indexOf(x)<4),v];}else draft.intents=draft.intents.filter(x=>x!==v);dirty=true;render();await save();}
    }catch(err){show(err.message,'error');}
  }
  async function refresh() { const out=await api('bootstrap');state=out;if(selected)await load(selected);else render(); }
  async function mutate(action, payload={}) { const result=await api(action,{id:selected,revision:detail.record.revision,...payload});await refresh();return result; }
  async function onClick(e) {
    const b=e.target.closest('[data-oo]');if(!b||busy)return;
    const action=b.dataset.oo;
    if(managerDirty && ['select','pane','refresh','next-cycle','generate','review_sheet','metrics','schedule','resuggest','retry','availability','consult','consult_done','cancel'].includes(action)){if(!await confirmAction('未保存の内容を破棄して画面を更新しますか？'))return;managerDirty=false;}
    busy=true;b.disabled=true;show('');
    try{
      if(action==='select'){await load(b.dataset.id);}
      else if(action==='pane'){pane=b.dataset.pane;render();}
      else if(action==='refresh'){await save();await refresh();}
      else if(action==='stage'){await save();stage=Number(b.dataset.stage);render();root.querySelector('h2')?.scrollIntoView({block:'start',behavior:'smooth'});}
      else if(action==='save'){await save();show('下書きを保存しました。','success');}
      else if(action==='edit'){editing=true;stage=0;render();}
      else if(action==='add-row'){const key=b.dataset.key;if(draft[key].length<3){const row=Object.fromEntries(definitions[key].map(([k])=>[k,k==='decision'?'維持':'']));draft[key].push(row);dirty=true;render();await save();}}
      else if(action==='remove-row'){draft[b.dataset.key].splice(Number(b.dataset.index),1);dirty=true;render();await save();}
      else if(action==='submit'){D.sanitizeDraft(draft,true);if(!await confirmAction('この内容を提出します。提出後は宮﨑さんが回答を閲覧できます。よろしいですか？'))return;await save();await mutate('submit',{body:draft});editing=false;pane='prepare';render();show('提出しました。通知と日程の状態は個別に管理されます。','success');}
      else if(action==='consult'){if(!await confirmAction('「個別相談の依頼があります」と宮﨑さんへ通知します。下書きや相談理由は送信しません。よろしいですか？'))return;await save();await mutate('consult');show('相談依頼を受け付けました。','success');}
      else if(['consult_done','resuggest','generate','review_sheet','metrics'].includes(action)){await mutate(action);}
      else if(action==='availability'){const result=await api('availability',{id:selected});root.querySelector('#ooAvailability').innerHTML=result.candidates.map(c=>`<p>${esc(slot(c.start))}：${c.available?'空きあり':'別の予定あり'}</p>`).join('');}
      else if(action==='schedule'||action==='cancel'){if(!await confirmAction(action==='cancel'?'コプロスの面談予定を取り消しますか？':`${slot(b.dataset.start)}でコプロスの予定表に登録しますか？`))return;const result=await mutate(action,{start:b.dataset.start,submissionId:detail.current.id});if(result.jobId){await api('dispatch',{id:result.jobId});await refresh();}}
      else if(action==='retry'){if(!await confirmAction('未確認の場合は外部サービス側の状態も確認してください。同じ処理IDで再実行しますか？'))return;await api('dispatch',{id:b.dataset.id});await refresh();}
      else if(action==='note'){await mutate('note',{note:root.querySelector('#ooPrivateNote').value});show('メモを保存しました。','success');}
      else if(action==='add-shared'){const container=root.querySelector('#ooSharedActions');if(container.children.length<6){container.insertAdjacentHTML('beforeend',sharedActionRow({status:'未着手'},container.children.length));managerDirty=true;}else show('本人の行動・会社の支援は合計6件までです。');}
      else if(action==='remove-shared'){b.closest('[data-shared-row]').remove();}
      else if(action==='share'){const body={summary:root.querySelector('#ooSharedSummary').value,actions:[...root.querySelectorAll('[data-shared-row]')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-shared]')].map(el=>[el.dataset.shared,el.value])))};D.sharedRecord(body);if(!await confirmAction('この合意事項を本人に共有します。非公開メモや分析を含めていないことを確認してください。'))return;await mutate('share',{body});show('合意事項を共有しました。','success');}
      else if(action==='acknowledge'){await mutate('acknowledge',{correction:root.querySelector('#ooCorrection').value});}
      else if(action==='feedback'){const data={comment:root.querySelector('#ooFeedback-comment').value};for(const k of ['heard','clear','helpful']){const v=root.querySelector(`#ooFeedback-${k}`).value;data[k]=v==='decline'?v:v?Number(v):null;}await mutate('feedback',data);show('振り返りを保存しました。','success');}
      else if(action==='progress'){const progress=[...root.querySelectorAll('[data-progress-row]')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-progress]')].map(el=>[el.dataset.progress,el.value])));await mutate('progress',{sharedVersion:detail.record.shared.version,progress});show('進捗を保存しました。','success');}
      else if(action==='cycle-settings'){const c=state.cycles.find(c=>c.id===cycle);root.insertAdjacentHTML('beforeend',`<dialog id="ooCycleDialog" style="margin:auto;padding:24px;border:1px solid #bbc7d0;border-radius:6px;max-width:420px;width:90%"><h2>${cycle}回の記入期間</h2><div class="oo-grid"><label class="oo-field">記入開始日<input type="date" id="ooOpenDate" value="${c.opens_at||''}"></label><label class="oo-field">提出期限<input type="date" id="ooDueDate" value="${c.deadline||''}"></label></div><div class="oo-actions">${button('close-dialog','キャンセル')}${button('save-cycle','設定を保存',true)}</div></dialog>`);root.querySelector('#ooCycleDialog').showModal();}
      else if(action==='close-dialog'){root.querySelector('#ooCycleDialog')?.remove();}
      else if(action==='save-cycle'){const opens_at=root.querySelector('#ooOpenDate').value,deadline=root.querySelector('#ooDueDate').value;state=await api('cycle',{cycle,opens_at,deadline});render();}
      else if(action==='evaluate'){await mutate('evaluate',{decision:root.querySelector('#ooDecision').value});}
      else if(action==='next-cycle'){const next=D.shiftCycle(cycle,2);if(!await confirmAction(`${next}回を準備しますか？`))return;state=await api('cycle',{cycle:next});cycle=next;selected=state.records.find(r=>r.cycle===cycle)?.id;if(selected)await load(selected);}
      else if(action==='print'){printSheet();}
    }catch(err){show(err.message,'error');}
    finally{busy=false;root?.querySelectorAll('[data-oo]').forEach(el=>el.disabled=false);}
  }
  function printSheet() {
    if(!manager()||!detail.sheet)return;
    document.querySelector('.oo-print')?.remove();
    const el=document.createElement('div');el.className='oo-print';const b=detail.current.body,s=detail.sheet;
    const short=(s,n=220)=>{const t=String(s||'');return esc(t.length>n?t.slice(0,n)+'…':t);};
    el.innerHTML=`<header><img src="logo.png" alt="D-WOLF"><div><h1>1on1 面談シート</h1><p>${esc(memberName(detail.record.user_id))}　${cycle}回　30分　${esc(slot(detail.record.meeting.start))}</p></div><span>面談担当者専用<br>提出 v${detail.current.version}</span></header><div class="oo-print-grid"><div><section><h2>本人が話したいこと・支援</h2><p>${short(b.topic)}</p><p>${short(b.support,150)}</p></section><section><h2>状態の確認</h2><table><tr><th>項目</th><th>前回</th><th>今回</th><th>差</th></tr>${detail.trends.map(t=>`<tr><td>${t.name}</td><td>${labelValue(t.before)}</td><td>${labelValue(t.value)}</td><td>${t.delta??'—'}</td></tr>`).join('')}</table></section><section><h2>前回の未完了事項</h2>${detail.pastRecords.flatMap(r=>(r.shared.actions||[]).filter(a=>!['完了','中止'].includes(a.status))).slice(0,3).map(a=>`<p>${short(a.text,65)} / ${short(a.owner,20)} / ${a.due}</p>`).join('')||'<p>記録なし</p>'}</section></div><div><section><h2>今回の確認質問（${s.source}・${s.reviewed?'確認済み':'要確認'}）</h2>${s.questions.map((q,i)=>`<p>${i+1}. ${short(q.text,160)}</p>`).join('')}</section><section><h2>半年後の目標</h2><p>${short(b.goal.text,150)}</p><p>目標日 ${esc(b.goal.due||'未設定')}</p></section><section><h2>業務・成長の論点</h2>${b.contributions.slice(0,2).map(r=>`<p>${short(r.action,80)} / ${short(r.evidence,80)}</p>`).join('')}${b.growth.slice(0,1).map(r=>`<p>${short(r.skill,80)} / ${short(r.value,80)}</p>`).join('')}</section></div><div><section><h2>次回までの行動案</h2>${b.actions.slice(0,3).map(a=>`<p>${short(a.text,70)}<br>期限 ${esc(a.due)} / ${short(a.metric,60)}</p>`).join('')}</section><section><h2>今回決める行動・会社の支援</h2><div class="oo-print-notes"></div><p>担当者：　　　　　期限：　　　　　完了条件：</p></section><section><h2>面談メモ</h2><div class="oo-print-notes"></div></section></div></div><footer>近況3分 → 本人のテーマ7分 → 成果・障害6分 → 成長・支援8分 → 行動の合意6分。原文はD-BORDに保存。長文は抜粋。状態の回答は離職予測・人事評価の点数ではありません。作成 ${stamp(new Date().toISOString())}</footer>`;
    const toolbar=document.createElement('div');toolbar.className='oo-print-toolbar';
    toolbar.innerHTML='<button type="button" class="oo-button" data-print-close>面談準備に戻る</button><button type="button" class="oo-button primary" data-print-go>印刷・PDF保存</button><span class="oo-muted">A4横・面談担当者専用</span>';
    toolbar.querySelector('[data-print-close]').onclick=()=>{document.body.classList.remove('oo-printing');el.remove();toolbar.remove();};
    toolbar.querySelector('[data-print-go]').onclick=()=>window.print();
    document.body.append(toolbar,el);document.body.classList.add('oo-printing');window.scrollTo(0,0);
  }
  window.addEventListener('afterprint',()=>{document.body.classList.remove('oo-printing');document.querySelector('.oo-print')?.remove();document.querySelector('.oo-print-toolbar')?.remove();});
  window.addEventListener('beforeunload',e=>{if(dirty||managerDirty){e.preventDefault();e.returnValue='';}});
  window.OneOnOne={attach,navigate,clear,show};
})();
