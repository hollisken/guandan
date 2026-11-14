/* ============================================================
 * 掼蛋训练所 - 界面逻辑 (ui.js)
 * ============================================================ */
(function () {
  'use strict';
  const GD = window.GD, E = GD.engine, A = GD.ai, TR = GD.trainer;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* ---------- 全局状态 ---------- */
  let g = null;                 // 当前 Game
  let selected = new Set();     // 选中的牌id
  let hintCards = null;         // 提示高亮的牌id集合
  let userDecisions = [];       // 本局用户的出牌决定(复盘用)
  let busy = false;             // AI思考中锁
  let viewMode = 'play';
  let quizStats = { right: 0, total: 0 };

  /* ---------- 工具 ---------- */
  function cardEl(c, level, cls) {
    const d = document.createElement('div');
    const red = c.suit === 'H' || c.suit === 'D';
    d.className = 'card ' + (cls || '') + ' ' + (c.suit === 'J' ? 'joker' : (red ? 'red' : 'black'));
    if (E.isWild(c, level)) d.classList.add('wild');
    const r = E.RANK_STR[c.rank], su = E.SUIT_STR[c.suit];
    if (c.suit === 'J') {
      const big = c.rank >= 16;
      d.classList.add(big ? 'joker-big' : 'joker-small');
      d.innerHTML = `<div class="tl">${big ? '大' : '小'}</div><div class="jk">${big ? '大<br>王' : '小<br>王'}</div><div class="br">${big ? '大' : '小'}</div>`;
    }
    else d.innerHTML = `<div class="tl">${r}<small>${su}</small></div><div class="br">${su}</div>`;
    return d;
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function speed() { return +$('#speedSel').value; }
  function coachOn() { return $('#coachToggle').checked; }

  function coach(type, title, bodyHtml) {
    const box = $('#coachBox');
    const div = document.createElement('div');
    div.className = 'coach-item ' + type;
    div.innerHTML = `<div class="ttl">${title}</div>` + (bodyHtml ? `<div class="why">${bodyHtml}</div>` : '');
    box.prepend(div);
    while (box.children.length > 60) box.lastChild.remove();
  }
  function logLine(s) {
    const box = $('#logBox');
    const div = document.createElement('div');
    div.innerHTML = s;
    box.prepend(div);
    while (box.children.length > 80) box.lastChild.remove();
  }

  /* ---------- 视图切换 ---------- */
  $$('#topbar .tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#topbar .tabs button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    viewMode = b.dataset.view;
    $$('.view').forEach(v => v.classList.remove('on'));
    $('#view-' + viewMode).classList.add('on');
    $('#sidebar').style.display = viewMode === 'play' ? 'flex' : 'none';
    if (viewMode === 'quiz') initQuizPage();
    if (viewMode === 'drill') initDrillPage();
    if (viewMode === 'compose' && (!compose || !$('#composeArea').children.length)) newComposeDrill();
    if (viewMode === 'residue') initResiduePage();
    if (viewMode === 'lesson') initLessonPage();
  }));

  /* ---------- 开局 ---------- */
  function newMatch() {
    g = new E.Game({ startLevel: 2, difficulty: $('#diffSel').value, userSeat: 0 });
    userDecisions = [];
    $('#coachBox').innerHTML = ''; $('#logBox').innerHTML = '';
    coach('info', '新比赛开始', '打2开始。你和<b>对家(北)</b>一队。右侧记牌器随时可看; 点<b>💡提示</b>让教练告诉你这一手怎么走、为什么。');
    $('#ovMatchEnd').classList.remove('on');
    startHand();
  }
  function startHand() {
    userDecisions = [];
    renderAll();
    showTributeInfo();
    if (g.phase === 'tribute' && g.tribute && needsUserReturn()) {
      showTributeOverlay();
    } else {
      tick();
    }
  }
  /* 贡牌/还贡是四家公开信息(规则: 还牌反扣, 双方还完同时亮牌) */
  function showTributeInfo() {
    const t = g.tribute;
    if (!t) return;
    if (t.resisted) {
      const who = (t.resistSeats || []).map(s => A.relName(s, 0)).join('、');
      coach('info', '🃏 抗贡(公开亮牌)', `${who} 亮出<b>两张大王</b>, 本局免贡——这两张王已经公开, 记牌时直接把它们当作"已见"。头游领出。`);
      logLine(`抗贡: ${who} 亮两张大王(公开)`);
      return;
    }
    if (!t.payers || !t.payers.length) return;
    const lines = t.payers.map(s => {
      const rec = t.giveTo[s];
      const given = t.returns[s], back = t.returns[rec];
      return `<b>${A.relName(s, 0)}</b> 贡 <b>${given ? E.cname(given, g.level) : '?'}</b> 给 ${A.relName(rec, 0)}　|　${A.relName(rec, 0)} 还 <b>${back ? E.cname(back, g.level) : '?'}</b> 给 ${A.relName(s, 0)}`;
    });
    coach('info', '🃏 进贡/还贡(四家公开)', lines.join('<br>') +
      '<br><span style="color:#8a7a55">规则: 还牌反扣桌上, 双方还完同时亮牌——这是判断两家牌力的硬情报, 务必记下。</span>');
    t.payers.forEach(s => {
      const rec = t.giveTo[s], given = t.returns[s], back = t.returns[rec];
      logLine(`贡: ${A.relName(s, 0)}→${A.relName(rec, 0)} ${given ? E.cname(given, g.level) : '?'}；还: ${A.relName(rec, 0)}→${A.relName(s, 0)} ${back ? E.cname(back, g.level) : '?'}`);
    });
  }
  function needsUserReturn() {
    return g.tribute.payers.some(s => g.tribute.giveTo[s] === 0);
  }

  /* ---------- 主循环 ---------- */
  let timer = null;
  function tick() {
    clearTimeout(timer);
    if (g.phase === 'handEnd') { showHandEnd(); return; }
    if (g.matchOver) { showMatchEnd(); return; }
    if (g.phase !== 'play') return;
    renderAll();
    if (g.turn === 0) onUserTurn();
    else { busy = true; updateActions(); timer = setTimeout(aiStep, speed()); }
  }
  async function aiStep() {
    if (g.phase !== 'play') { busy = false; tick(); return; }
    const seat = g.turn;
    const r = A.aiMove(g, seat);
    if (!r) {
      g.play(seat, null);
      renderPlays(); logLine(`${A.relName(seat, 0)}:不要`);
    } else {
      const res = g.play(seat, r.move.cards);
      if (!res.ok) { console.error('AI出牌非法', res, r.move); g.play(seat, null); }
      else {
        renderPlays();
        logLine(`${A.relName(seat, 0)}: ${E.comboDesc(r.move, g.level)} ${E.cnames(r.move.cards, g.level)}`);
        if (r.analysis && r.analysis.notes.length && Math.random() < 0.25) {
          const n = r.analysis.notes[Math.floor(Math.random() * r.analysis.notes.length)];
          if (Math.abs(n.w) >= 600 || n.k === 'pimc') coach('info', A.relName(seat, 0) + '的思路', n.t);
        }
      }
    }
    busy = false;
    tick();
  }
  function onUserTurn() {
    selected.clear(); hintCards = null;
    renderAll();
    // 合法性
    const moves = E.genMoves(g.hands[0], g.level, g.trick ? g.trick.combo : null);
    $('#btnPlay').disabled = moves.length === 0;
    $('#btnPass').disabled = !g.trick; // 规则: 能压也可选择不要; 只有领出时不能不要
    $('#btnHint').disabled = false;
    $('#turnArrow').style.display = 'block';
    $('#turnArrow').textContent = g.trick ? `轮到你 — 需要压过 ${A.relName(g.trick.seat, 0)}的 ${E.comboDesc(g.trick.combo, g.level)} ${E.cnames(g.trick.combo.cards, g.level)}` : '轮到你领出';
    if (coachOn()) {
      const best = A.aiMove(g, 0, 'hard');
      if (best) {
        const whys = best.analysis.notes.map(n => `<li>${n.t}</li>`).join('');
        coach('suggest', `教练建议: ${E.comboDesc(best.move, g.level)} ${E.cnames(best.move.cards, g.level)}`, `<ul>${whys}</ul>`);
      }
    }
  }

  /* ---------- 用户操作 ---------- */
  $('#btnPlay').addEventListener('click', () => {
    if (busy) return;
    const cards = g.hands[0].filter(c => selected.has(c.id));
    if (!cards.length) return;
    // 先评价(用出牌前局面)
    const combo = E.interpret(cards, g.level, g.trick ? g.trick.combo : null);
    const judge = coachOn() ? A.judgeUserMove(g, 0, combo) : null;
    const res = g.play(0, cards);
    if (!res.ok) { coach('bad', '不能这么出', res.err); return; }
    selected.clear(); hintCards = null;
    if (judge) {
      const cls = judge.grade === 'good' ? 'good' : judge.grade === 'bad' ? 'bad' : 'ok';
      const icon = judge.grade === 'good' ? '✔' : judge.grade === 'bad' ? '✘' : '△';
      const whys = (judge.notes || []).slice(0, 3).map(n => `<li>${n.t}</li>`).join('');
      const better = judge.best && (combo == null || judge.best.move.type !== combo.type || judge.best.move.value !== combo.value)
        ? `<div>更优参考: ${E.comboDesc(judge.best.move, g.level)} ${E.cnames(judge.best.move.cards, g.level)}</div>` : '';
      coach(cls, `${icon} 你出了 ${combo ? E.comboDesc(combo, g.level) + ' ' + E.cnames(cards, g.level) : '不要'} — ${judge.head}`, whys + better);
      userDecisions.push({ desc: combo ? E.comboDesc(combo, g.level) + ' ' + E.cnames(cards, g.level) : '不要', grade: judge.grade, head: judge.head, better });
    }
    logLine(`<b>你</b>: ${combo ? E.comboDesc(combo, g.level) + ' ' + E.cnames(cards, g.level) : '不要'}`);
    tick();
  });
  $('#btnPass').addEventListener('click', () => {
    if (busy) return;
    const judge = coachOn() ? A.judgeUserMove(g, 0, null) : null;
    const res = g.play(0, null);
    if (!res.ok) return;
    selected.clear(); hintCards = null;
    if (judge) {
      const cls = judge.grade === 'good' ? 'good' : 'ok';
      coach(cls, `△ 你选择了不要 — ${judge.head}`, '');
      userDecisions.push({ desc: '不要', grade: judge.grade, head: judge.head });
    }
    logLine(`<b>你</b>: 不要`);
    tick();
  });
  $('#btnHint').addEventListener('click', () => {
    if (busy) return;
    const best = A.aiMove(g, 0, 'hard');
    if (!best) { coach('info', '只能不要', ''); return; }
    hintCards = new Set(best.move.cards.map(c => c.id));
    renderMyHand();
    const whys = best.analysis.notes.map(n => `<li>${n.t}</li>`).join('');
    coach('suggest', `提示: ${E.comboDesc(best.move, g.level)} ${E.cnames(best.move.cards, g.level)}`, `<ul>${whys}</ul>`);
  });

  /* ---------- 渲染 ---------- */
  function renderAll() { renderSeats(); renderMyHand(); renderPlays(); renderRecorder(); renderSitch(); renderLevel(); updateActions(); }

  function renderSeats() {
    for (let s = 1; s <= 3; s++) {
      const el = $('#seat' + s);
      const n = g.hands[s].length;
      el.querySelector('.cnt').textContent = n > 0 ? `剩${n}张` : '已走完';
      const badge = el.querySelector('.badge');
      badge.classList.toggle('show', n > 0 && n <= 2);
      badge.textContent = n <= 2 ? (n === 1 ? '报单!' : '报双!') : '';
      const fan = el.querySelector('.fan');
      fan.innerHTML = '';
      for (let i = 0; i < Math.min(n, 12); i++) { const b = document.createElement('div'); b.className = 'card back sm'; b.style.marginLeft = i ? '-26px' : '0'; fan.appendChild(b); }
      el.style.opacity = n === 0 ? .35 : 1;
      el.classList.toggle('active-seat', g.phase === 'play' && g.turn === s);
    }
    const me = $('#seat0');
    me.querySelector('.cnt').textContent = `剩${g.hands[0].length}张`;
    const mb = me.querySelector('.badge');
    mb.classList.toggle('show', g.hands[0].length === 10);
  }

  function renderMyHand() {
    const box = $('#myHand');
    box.innerHTML = '';
    const hand = E.sortHand(g.hands[0].slice(), g.level);
    for (const c of hand) {
      const el = cardEl(c, g.level);
      if (selected.has(c.id)) el.classList.add('sel');
      if (hintCards && hintCards.has(c.id)) el.classList.add('hint');
      if (g.phase === 'play' && g.turn === 0 && !busy) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          if (selected.has(c.id)) selected.delete(c.id); else selected.add(c.id);
          renderMyHand();
        });
      }
      box.appendChild(el);
    }
  }

  function renderPlays() {
    for (let s = 0; s < 4; s++) {
      const box = $('#played' + s);
      box.innerHTML = '';
      const last = [...g.playLog].reverse().find(e => e.seat === s);
      if (!last) continue;
      if (last.pass) { box.innerHTML = '<span class="pass">不要</span>'; continue; }
      for (const c of last.cards) box.appendChild(cardEl(c, g.level, 'sm'));
      const tag = document.createElement('div');
      tag.className = 'tag'; tag.textContent = E.comboDesc(last.combo, g.level);
      box.appendChild(tag);
    }
  }

  function renderRecorder() {
    const info = E.unseenInfo(g, 0);
    const box = $('#recorder');
    box.innerHTML = '';
    const entries = [];
    for (let r = 2; r <= 14; r++) entries.push({ rank: r, name: E.RANK_STR[r], n: info.byRank[r] });
    entries.push({ rank: 15, name: '小王', n: info.byRank[15] });
    entries.push({ rank: 16, name: '大王', n: info.byRank[16] });
    for (const e of entries) {
      const d = document.createElement('div');
      d.className = 'rc' + (e.n >= 4 ? ' risk' : '') + (e.n === 0 ? ' zero' : '') + (['H'].includes('') ? '' : '');
      const red = e.rank <= 14 && (e.name.includes('♥'));
      d.innerHTML = `<div class="rk">${e.name}</div><div class="ct">${e.n}</div>`;
      box.appendChild(d);
    }
  }

  function renderSitch() {
    const cp = A.coachPanel(g, 0);
    const rows = [];
    const names = ['对家(同伴)', '下家', '', '上家'];
    for (let s = 1; s <= 3; s++) {
      const n = g.hands[s].length;
      const team = g.teamOf(s) === 0 ? '同伴' : '对手';
      const warn = n <= 2 ? ' ⚠报单' : (n === 10 ? ' 报牌' : '');
      rows.push(`<div class="row"><span class="who">${['', '下家 东', '对家 北·同伴', '上家 西'][s]}</span><span class="cnt">${n === 0 ? '已走完' : '剩' + n + '张'}</span><span class="memo">${team}${warn}</span></div>`);
    }
    rows.push(`<div class="row"><span class="who">你 南</span><span class="cnt">剩${g.hands[0].length}张</span><span class="memo">${g.hands[0].length === 10 ? '你需报牌' : ''}</span></div>`);
    rows.push('<div style="margin-top:6px">' + cp.pts.map(p => `• ${p}`).join('<br>') + '</div>');
    $('#sitch').innerHTML = rows.join('');
  }

  function renderLevel() {
    $('#lvText').textContent = '打 ' + E.levelStr(g.level);
    $('#lvSub').textContent = `第 ${g.handNo} 局 · 你与对家一队${g.tribute && g.tribute.resisted ? ' · 抗贡' : ''}`;
    $('#levelinfo').textContent = `打${E.levelStr(g.level)} · 第${g.handNo}局`;
  }

  function updateActions() {
    const myTurn = g && g.phase === 'play' && g.turn === 0 && !busy;
    $('#actions').style.display = myTurn ? 'flex' : 'none';
    if (myTurn) {
      const moves = E.genMoves(g.hands[0], g.level, g.trick ? g.trick.combo : null);
      $('#btnPlay').disabled = selected.size === 0 || moves.length === 0;
      $('#btnPass').disabled = !g.trick;
    }
    $('#turnArrow').style.display = myTurn ? 'block' : 'none';
  }

  /* ---------- 贡牌 ---------- */
  function showTributeOverlay() {
    const ov = $('#ovTribute');
    const box = $('#tributeCards');
    box.innerHTML = '';
    E.sortHand(g.hands[0], g.level);
    for (const c of g.hands[0]) {
      const el = cardEl(c, g.level);
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        ov.classList.remove('on');
        g.userReturnTribute(c);
        coach('info', '还贡完成', `你还了一张${E.cname(c, g.level)}。要点: 还小牌=保住大牌实力; 你还了什么, 对方就知道了你留着什么结构 —— 还贡本身就是信息。`);
        startHand();
      });
      box.appendChild(el);
    }
    ov.classList.add('on');
  }

  /* ---------- 结算与复盘 ---------- */
  function showHandEnd() {
    renderAll();
    const r = g.lastResult;
    const winTeam = r.winTeam;
    const weWin = winTeam === 0;
    $('#heTitle').textContent = weWin ? '🎉 我方获胜' : '对方获胜';
    const names = ['你 南', '下家 东', '对家 北', '上家 西'];
    let html = `<table><tr><th>名次</th><th>玩家</th><th>队伍</th></tr>`;
    r.ranks.forEach((s, i) => { html += `<tr><td>${['头游', '二游', '三游', '末游'][i]}</td><td>${names[s]}</td><td>${g.teamOf(s) === 0 ? '我方' : '对方'}</td></tr>`; });
    html += `</table>`;
    if (r.isDoubleDown) html += `<div>双下! ${weWin ? '我方' : '对方'}头游+二游, 升 <b>${r.inc}</b> 级。</div>`;
    else html += `<div>${weWin ? '我方' : '对方'}头游, 同伴${['', '二游', '三游', '末游'][r.ranks.indexOf(g.partnerOf(r.first)) + 1] || ''}, 升 <b>${r.inc}</b> 级。</div>`;
    if (r.passedA) html += `<div style="color:#2e8b57;font-weight:700">打过A! 比赛结束。</div>`;
    if (r.stayA) html += `<div style="color:#c0392b">打A未过(同伴末游), 留在A。</div>`;
    html += `<div style="margin-top:6px">下一局打 <b>${E.levelStr(g.level)}</b>${g.matchOver ? '' : ' · ' + (weWin ? '对方' : '我方')}进贡</div>`;
    // 复盘
    let rep = '';
    if (userDecisions.length) {
      rep = '<h3 style="margin:12px 0 6px;font-size:15px;color:#6b4d0e">📋 你的出手复盘</h3><table><tr><th>你出了</th><th>教练点评</th></tr>';
      for (const d of userDecisions) {
        const cls = d.grade === 'good' ? 'grade-yes' : d.grade === 'bad' ? 'grade-no' : 'grade-mid';
        const icon = d.grade === 'good' ? '✔' : d.grade === 'bad' ? '✘' : '△';
        rep += `<tr><td>${d.desc}</td><td><span class="${cls}">${icon}</span> ${d.head}${d.better ? '<br><span style="color:#888;font-size:12px">' + (d.better || '') + '</span>' : ''}</td></tr>`;
      }
      rep += '</table>';
    } else rep = '<div style="color:#999;margin-top:8px">(本局你无出手记录)</div>';
    $('#heBody').innerHTML = html;
    $('#heReplay').innerHTML = rep;
    $('#btnNextHand').textContent = g.matchOver ? '查看结果' : '下一局';
    $('#ovHandEnd').classList.add('on');
  }
  $('#btnNextHand').addEventListener('click', () => {
    $('#ovHandEnd').classList.remove('on');
    if (g.matchOver) { showMatchEnd(); return; }
    g.nextHand();
    startHand();
  });
  function showMatchEnd() {
    const weWin = g.winTeam === 0;
    $('#meTitle').textContent = weWin ? '🏆 我方从打2打到A, 获胜!' : '对方先打过A';
    $('#meBody').innerHTML = `共 ${g.handNo} 局。最终级牌: ${E.levelStr(g.level)}。<br>复盘要点: 每局结束后在"你的出手复盘"里看教练的✘点评, 那里提升最快。`;
    $('#ovMatchEnd').classList.add('on');
  }
  $('#btnRematch').addEventListener('click', () => { $('#ovMatchEnd').classList.remove('on'); newMatch(); });

  /* ---------- 记牌训练页 ---------- */
  let quizGame = null, quizItem = null;
  function makeQuizGame() {
    const g2 = new E.Game({ startLevel: 2 + Math.floor(Math.random() * 13), difficulty: 'hard' });
    // 模拟进行若干手
    const hands = 1 + Math.floor(Math.random() * 3);
    for (let h = 0; h < hands; h++) {
      let steps = 0, target = 8 + Math.floor(Math.random() * 30);
      while (g2.phase === 'play' && steps < target) {
        steps++;
        const r = A.aiMove(g2, g2.turn);
        g2.play(g2.turn, r ? r.move.cards : null);
        if (g2.phase === 'handEnd') break;
      }
      if (g2.phase === 'handEnd') { if (h < hands - 1) g2.nextHand(); }
    }
    return g2;
  }
  function initQuizPage() {
    if (!quizGame || $('#quizArea').children.length === 0) nextQuiz();
  }
  function nextQuiz() {
    quizGame = makeQuizGame();
    askQuiz();
  }
  function askQuiz() {
    quizItem = TR.makeMemoryQuiz(quizGame);
    quizStats.total++;
    const area = $('#quizArea');
    const info = E.unseenInfo(quizGame, 0);
    area.innerHTML = `
      <div class="drillcard">
        <h3>局面快照 · 打${E.levelStr(quizGame.level)} · 第${quizGame.handNo}局 已出${quizGame.playedAll.length}张</h3>
        <div class="q">你的手牌: ${E.cnames(E.sortHand(quizGame.hands[0].slice(), quizGame.level), quizGame.level)}
        \n下家剩${quizGame.hands[1].length} / 对家剩${quizGame.hands[2].length} / 上家剩${quizGame.hands[3].length}
        \n\n❓ ${quizItem.q}</div>
        <div class="opts">${quizItem.options.map((o, i) => `<button data-i="${i}">${o}</button>`).join('')}</div>
        <div class="expl">${quizItem.explain}
        \n【记牌器核对】\n${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(r => E.RANK_STR[r] + ':' + info.byRank[r]).join('  ')}</div>
      </div>`;
    $$('#quizArea .opts button').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.i;
      $$('#quizArea .opts button').forEach((x, j) => { x.disabled = true; if (j === quizItem.answer) x.classList.add('right'); else if (j === i) x.classList.add('wrong'); });
      $('#quizArea .drillcard').classList.add('done');
      if (i === quizItem.answer) quizStats.right++;
      $('#quizScore').textContent = `${quizStats.right} / ${quizStats.total}`;
      const next = document.createElement('button');
      next.className = 'btn'; next.style.marginTop = '10px'; next.textContent = '下一题(新局面)';
      next.addEventListener('click', nextQuiz);
      $('#quizArea').appendChild(next);
    }));
  }
  $('#btnQuizNew').addEventListener('click', nextQuiz);

  /* ---------- 出牌习题页 ---------- */
  function initDrillPage() { if (!$('#drillArea').children.length) nextDrill(); }
  function nextDrill() {
    const d = TR.makePlayDrill();
    const area = $('#drillArea');
    if (!d) { area.innerHTML = '<div class="drillcard">生成失败, 再点一次"换一题"</div>'; return; }
    area.innerHTML = `
      <div class="drillcard">
        <h3>${d.title}</h3>
        <div class="q">${d.situation}</div>
        <div class="opts">${d.options.map((o, i) => `<button data-i="${i}">${o.label}</button>`).join('')}</div>
        <div class="expl">${d.explain}</div>
      </div>`;
    $$('#drillArea .opts button').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.i;
      $$('#drillArea .opts button').forEach((x, j) => { x.disabled = true; if (j === d.answer) x.classList.add('right'); else if (j === i) x.classList.add('wrong'); });
      $('#drillArea .drillcard').classList.add('done');
    }));
  }
  $('#btnDrillNew').addEventListener('click', nextDrill);

  /* ---------- 组牌训练页(拆牌/组牌专项) ---------- */
  let compose = null;
  function newComposeDrill() {
    const level = 2 + Math.floor(Math.random() * 13);
    const n = 12 + Math.floor(Math.random() * 5);
    const deck = E.shuffle(E.makeDeck());
    const hand = deck.slice(0, n);
    if (Math.random() < 0.5 && !hand.some(c => E.isWild(c, level))) hand[0] = { id: 'wild1', rank: level, suit: 'H' };
    E.sortHand(hand, level);
    compose = { level, hand, groups: [], sel: new Set(), done: null };
    renderCompose();
  }
  function renderCompose() {
    const a = $('#composeArea');
    a.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'drillcard';
    const groupedIds = new Set(compose.groups.flatMap(gr => gr.cards.map(c => c.id)));
    const free = compose.hand.filter(c => !groupedIds.has(c.id));
    box.innerHTML = `<h3>组牌 · 打${E.levelStr(compose.level)} · 共${compose.hand.length}张</h3>
      <div style="font-size:13px;color:#666;margin-bottom:4px">已组 <b>${compose.groups.length}</b> 手 · 未组的散牌各算一手 · 目标: 总手数最少</div>`;
    const freeRow = document.createElement('div');
    freeRow.className = 'handrow';
    freeRow.style.cssText = 'flex-wrap:wrap;justify-content:flex-start;margin-left:0';
    for (const c of free) {
      const el = cardEl(c, compose.level);
      if (compose.sel.has(c.id)) el.classList.add('sel');
      el.style.cssText = 'cursor:pointer;margin-top:14px';
      el.addEventListener('click', () => {
        if (compose.sel.has(c.id)) compose.sel.delete(c.id); else compose.sel.add(c.id);
        renderCompose();
      });
      freeRow.appendChild(el);
    }
    box.appendChild(freeRow);
    if (compose.groups.length) {
      const gd = document.createElement('div');
      gd.style.marginTop = '16px';
      gd.innerHTML = '<b style="font-size:13px;color:#6b4d0e">已组:</b>';
      compose.groups.forEach((gr, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0';
        row.innerHTML = `<span style="font-size:13px;width:110px;color:#555">${E.comboDesc(gr.combo, compose.level)}</span>`;
        const cr = document.createElement('div');
        cr.className = 'handrow';
        cr.style.cssText = 'justify-content:flex-start;margin-left:0';
        for (const c of gr.cards) {
          const el = cardEl(c, compose.level, 'sm');
          if (c.wildFor) el.classList.add('wild');
          cr.appendChild(el);
        }
        row.appendChild(cr);
        const undo = document.createElement('button');
        undo.className = 'btn gray';
        undo.style.cssText = 'padding:2px 10px;font-size:12px';
        undo.textContent = '拆掉';
        undo.addEventListener('click', () => { compose.groups.splice(i, 1); renderCompose(); });
        row.appendChild(undo);
        gd.appendChild(row);
      });
      box.appendChild(gd);
    }
    if (compose.done) box.appendChild(compose.done);
    a.appendChild(box);
  }
  function composeCompare() {
    const groupedIds = new Set(compose.groups.flatMap(gr => gr.cards.map(c => c.id)));
    const freeCnt = compose.hand.filter(c => !groupedIds.has(c.id)).length;
    const userCount = compose.groups.length + freeCnt;
    const dec = A.decompose(compose.hand, compose.level);
    const verdict = document.createElement('div');
    const good = userCount <= dec.count;
    verdict.style.cssText = 'margin-top:14px;padding:12px 16px;background:#fff7e0;border-left:4px solid var(--gold);border-radius:6px;font-size:13.5px;line-height:1.8';
    const aiRows = dec.hands.map(h => `<div style="margin:3px 0"><b>${E.comboDesc(h, compose.level)}</b>　${h.cards.map(c => E.cname(c, compose.level)).join(' ')}</div>`).join('');
    verdict.innerHTML = `<b>你的手数: ${userCount}　|　AI最少: ${dec.count} 手</b>　${good ? '👍 已达到AI水平!' : '—— 还有优化空间, 看AI的拆法:'}
      <div style="margin-top:8px">${aiRows}</div>
      <div style="margin-top:8px;color:#8a7a55">组牌要点: ①散单是负债——顺子/三连对优先"吃"散单; ②别拆对子凑顺; ③逢人配优先补顺子(一张变一手五张); ④拆牌是为了再组牌: 把困难牌转成能顺走的牌。</div>`;
    compose.done = verdict;
    renderCompose();
  }
  $('#btnComposeNew').addEventListener('click', newComposeDrill);
  $('#btnComposeUndo').addEventListener('click', () => { if (compose) { compose.done = null; compose.groups.pop(); renderCompose(); } });
  $('#btnComposeGroup').addEventListener('click', () => {
    if (!compose || !compose.sel.size) return;
    const cards = compose.hand.filter(c => compose.sel.has(c.id));
    const combo = E.interpret(cards, compose.level, null);
    if (!combo) { alert('这些牌不成合法牌型（单/对/三/三带二/顺子恰5张/三连对/钢板二连三/炸弹）'); return; }
    compose.groups.push({ combo, cards });
    compose.sel.clear(); compose.done = null;
    renderCompose();
  });
  $('#btnComposeCompare').addEventListener('click', () => { if (compose) composeCompare(); });

  /* ---------- 精讲残局页 ---------- */
  function initResiduePage() {
    const area = $('#residueArea');
    area.innerHTML = '<div class="quizhead"><b>精讲残局</b><span class="mini">六个经典战术场景, 每题教一个核心意识</span></div>';
    TR.DRILLS.forEach(dr => {
      const card = document.createElement('div');
      card.className = 'drillcard';
      card.innerHTML = `
        <h3>${dr.title}</h3>
        <div class="q">${dr.question}
        \n你的手牌: ${E.cnames(E.sortHand(dr.hands[0].slice(), dr.level), dr.level)}
        \n下家: ${dr.hands[1].length}张 | 对家: ${dr.hands[2].length}张 | 上家: ${dr.hands[3].length}张
        </div>
        <div class="opts">${dr.options.map((o, i) => `<button data-i="${i}">${o.label}</button>`).join('')}</div>
        <div class="expl">${dr.explain}</div>`;
      card.querySelectorAll('.opts button').forEach(b => b.addEventListener('click', () => {
        const i = +b.dataset.i;
        card.querySelectorAll('.opts button').forEach((x, j) => { x.disabled = true; if (j === dr.answer) x.classList.add('right'); else if (j === i) x.classList.add('wrong'); });
        card.classList.add('done');
      }));
      area.appendChild(card);
    });
  }

  /* ---------- 课程页 ---------- */
  function initLessonPage() {
    const area = $('#lessonArea');
    area.innerHTML = '<div class="quizhead"><b>掼蛋七讲</b><span class="mini">点标题展开 · 先读第2、3、5讲, 提升最快</span></div>';
    GD.lessons.forEach((ls, i) => {
      const div = document.createElement('div');
      div.className = 'lesson' + (i === 0 ? ' open' : '');
      const body = (ls.body || []).map(p => `<p>${p}</p>`).join('');
      const pts = ls.points ? `<div class="pts"><b>📌 记忆要点</b><ul>${ls.points.map(p => `<li>${p}</li>`).join('')}</ul></div>` : '';
      div.innerHTML = `<h2>${ls.title}</h2><div class="bd">${body}${pts}</div>`;
      div.querySelector('h2').addEventListener('click', () => div.classList.toggle('open'));
      area.appendChild(div);
    });
  }

  /* ---------- 控件 ---------- */
  $('#btnNew').addEventListener('click', () => { clearTimeout(timer); newMatch(); });
  $('#diffSel').addEventListener('change', () => { if (g) { g.difficulty = $('#diffSel').value; coach('info', '难度调整', '新难度从下一手起生效。'); } });
  window.addEventListener('resize', () => { });

  /* 调试/托管钩子: 同步推演(不依赖定时器, 也用于自动测试) */
  function syncUserPlay() {
    const b = A.aiMove(g, 0, 'hard');
    const combo = b ? E.interpret(b.move.cards, g.level, g.trick ? g.trick.combo : null) : null;
    const judge = A.judgeUserMove(g, 0, combo);
    const res = g.play(0, b ? b.move.cards : null);
    selected.clear(); hintCards = null;
    if (res.ok) {
      const cls = judge.grade === 'good' ? 'good' : judge.grade === 'bad' ? 'bad' : 'ok';
      const icon = judge.grade === 'good' ? '✔' : judge.grade === 'bad' ? '✘' : '△';
      coach(cls, `${icon} ${combo ? '你出了 ' + E.comboDesc(combo, g.level) : '你选择了不要'} — ${judge.head}`, '');
      userDecisions.push({ desc: combo ? E.comboDesc(combo, g.level) + ' ' + E.cnames(b.move.cards, g.level) : '不要', grade: judge.grade, head: judge.head });
      logLine(`<b>你</b>(托管): ${combo ? E.comboDesc(combo, g.level) : '不要'}`);
    }
    return res.ok ? 'ok' : r0(res);
    function r0(r) { return r.err || 'err'; }
  }
  function syncFF() {
    let n = 0;
    while (g.phase === 'play' && g.turn !== 0 && n++ < 400) {
      const r = A.aiMove(g, g.turn);
      const res = g.play(g.turn, r ? r.move.cards : null);
      if (!res.ok) { g.play(g.turn, null); }
      else logLine(`${A.relName(g.turn, 0)}: ${r ? E.comboDesc(r.move, g.level) : '不要'}`);
    }
    return n;
  }
  function syncAfter() {
    renderAll();
    if (g.phase === 'handEnd') showHandEnd();
    else if (g.matchOver) showMatchEnd();
    else if (g.phase === 'play' && g.turn === 0) { selected.clear(); renderAll(); }
  }
  window.__gd = {
    g: () => g,
    overlay() { return $('#ovHandEnd').classList.contains('on') ? 'handEnd' : $('#ovTribute').classList.contains('on') ? 'tribute' : $('#ovMatchEnd').classList.contains('on') ? 'matchEnd' : ''; },
    /* 用户按最佳出一手(同步) */
    playBest() {
      if (!g || g.phase !== 'play' || g.turn !== 0) return 'not-your-turn';
      const r = syncUserPlay();
      syncAfter();
      return r;
    },
    /* 快进AI回合直到轮到用户/本局结束 */
    ff() { syncFF(); syncAfter(); return 'ff'; },
    /* 自动还贡 */
    returnTribute() {
      const c = [...document.querySelectorAll('#tributeCards .card')].find(x => x.style.cursor === 'pointer');
      if (c) { c.click(); return true; } return false;
    },
    /* 推进一步 */
    step() {
      const ov = this.overlay();
      if (ov === 'handEnd') { clearTimeout(timer); $('#btnNextHand').click(); return 'nexthand'; }
      if (ov === 'tribute') return this.returnTribute() ? 'tribute' : 'tribute-stuck';
      if (ov === 'matchEnd') return 'matchEnd';
      if (!g || g.phase === 'handEnd') { showHandEnd(); return 'handEnd'; }
      if (g.phase !== 'play') return 'phase:' + g.phase;
      if (g.turn === 0) return this.playBest();
      clearTimeout(timer); this.ff(); return 'ai';
    },
    /* 一路托管到比赛结束 */
    run(maxSteps) {
      const trace = [];
      for (let i = 0; i < (maxSteps || 6000); i++) {
        const r = this.step();
        trace.push(r);
        if (r === 'matchEnd') break;
      }
      return { last: trace.slice(-6), hands: g.handNo, level: g.level, matchOver: g.matchOver, overlay: this.overlay() };
    }
  };

  /* ---------- 启动 ---------- */
  newMatch();
})();
