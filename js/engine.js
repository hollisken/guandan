/* ============================================================
 * 掼蛋训练器 - 引擎层 (engine.js)
 * 规则依据:《江苏省掼蛋竞赛简易规则(2017版)》
 *  - 牌点从大到小: 大王 > 小王 > 级牌 > A > K > ... > 3 > 2
 *  - 顺子五张: A2345(最小, A作1) ~ 10JQKA(最大), 2 可进顺子, JQKA2 不合法
 *  - 三连对(木板)必须且只能是三连对(6张); 三同连张(钢板)必须且只能是二连三(6张) — 依《掼蛋竞赛规则》
 *  - 炸弹: 4~10张同点(逢人配可配炸, 最多10张); 同花顺压≤5张炸弹, 6+张炸弹压同花顺; 四大天王最大
 *  - 升级: 同伴二游+3, 三游+2, 末游+1; 打A须同伴非末游才能过A
 *  - 贡牌: 进贡牌点最大单张(红桃级牌除外); 抗贡=抓到两张大王(双贡时任一家有即全抗);
 *    还牌: 还给对方可任意(习惯还小牌), 还给己方搭档须≤10; 进贡者领出
 *  - 压牌自由: 能压时也可选择"不要"
 *  - 接风: 出完牌者获胜后无人再接 → 其同伴接风领出
 * ============================================================ */
(function (root) {
  'use strict';
  const GD = (root.GD = root.GD || {});

  /* ---------- 基础牌定义 ---------- */
  const SUITS = ['S', 'H', 'D', 'C'];           // 黑桃/红桃/方块/梅花
  const JOKER_S = 15, JOKER_B = 16;             // 小王/大王的 rank
  const RANK_STR = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小王', 16: '大王' };
  const SUIT_STR = { S: '♠', H: '♥', D: '♦', C: '♣', J: '' };
  const RED_SUITS = { H: 1, D: 1 };

  function makeDeck() {
    const cards = []; let id = 0;
    for (let d = 0; d < 2; d++) {
      for (const s of SUITS) for (let r = 2; r <= 14; r++) cards.push({ id: 'c' + (id++), rank: r, suit: s });
      cards.push({ id: 'c' + (id++), rank: JOKER_S, suit: 'J' });
      cards.push({ id: 'c' + (id++), rank: JOKER_B, suit: 'J' });
    }
    return cards;
  }

  function isWild(c, level) { return c.suit === 'H' && c.rank === level; }   // 逢人配
  function isJoker(c) { return c.rank >= JOKER_S; }

  /* 单张比较值: 大王18 > 小王17 > 级牌15 > A14 ... > 2 */
  function ov(c, level) {
    if (c.rank === JOKER_B) return 18;
    if (c.rank === JOKER_S) return 17;
    if (c.rank === level) return 15;
    return c.rank;
  }
  function ovRank(rank, level) { return ov({ rank }, level); }

  function cname(c, level) {
    if (c.suit === 'J') return RANK_STR[c.rank];
    if (level && c.rank === level && c.suit === 'H') return '♥' + RANK_STR[c.rank] + '(逢人配)';
    return SUIT_STR[c.suit] + RANK_STR[c.rank];
  }
  function cnames(cards, level) { return cards.map(c => cname(c, level)).join(' '); }

  /* 手牌排序: 值大在前; 同值 级牌/红桃靠前 */
  const SUIT_ORDER = { H: 0, S: 1, C: 2, D: 3, J: 4 };
  function sortHand(hand, level) {
    hand.sort((a, b) => {
      const d = ov(b, level) - ov(a, level);
      if (d) return d;
      const s = SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
      return s || (a.rank - b.rank);
    });
    return hand;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /* ---------- 牌型识别 ---------- */
  /* Combo: {type, n, value, k?, suit?, cards, usedWild}
   * type: single pair triple triple2 straight pairseq plate bomb sf rocket */
  const TYPE_NAME = { single: '单张', pair: '对子', triple: '三张', triple2: '三带二', straight: '顺子', pairseq: '连对', plate: '钢板', bomb: '炸弹', sf: '同花顺', rocket: '四大天王' };

  function tier(c) { return (c.type === 'bomb' || c.type === 'sf' || c.type === 'rocket') ? 1 : 0; }
  function bombWeight(c) { return c.type === 'rocket' ? 99 : c.type === 'sf' ? 5.5 : c.n; }
  function strength(c) {
    if (c.type === 'rocket') return 100000;
    if (c.type === 'bomb') return 40000 + c.n * 100 + c.value;
    if (c.type === 'sf') return 40000 + 550 + c.value;
    return c.value * 10 + c.n;
  }
  function beats(a, b) {
    if (!b) return true;
    if (a.type === 'rocket') return true;
    if (b.type === 'rocket') return false;
    const ta = tier(a), tb = tier(b);
    if (ta !== tb) return ta === 1;
    if (ta === 0) return a.type === b.type && a.n === b.n && a.value > b.value;
    const w = bombWeight(a) - bombWeight(b);
    return w !== 0 ? w > 0 : a.value > b.value;
  }
  function comboDesc(c, level) {
    let s = TYPE_NAME[c.type];
    if (c.type === 'pairseq') s = '三连对';
    if (c.type === 'plate') s = '钢板(二连三)';
    if (c.type === 'bomb') s = c.n + '张炸弹';
    return s;
  }

  /* 将一组具体牌(百搭已赋值)按整体识别为牌型; 不合法返回 null */
  function patternOf(cs, level) {
    const n = cs.length;
    if (!n) return null;
    if (n === 4 && cs.every(c => c.rank >= JOKER_S)) return { type: 'rocket', n: 4, value: 100 };
    const vals = cs.map(c => c.rank);
    if (vals.every(v => v === vals[0])) {
      const value = ovRank(vals[0], level);
      if (n === 1) return { type: 'single', n: 1, value };
      if (n === 2) return { type: 'pair', n: 2, value };
      if (n === 3) return { type: 'triple', n: 3, value };
      if (n >= 4 && n <= 10) return { type: 'bomb', n, value };
      return null;
    }
    if (n === 5) { // 三带二
      const cnt = {}; vals.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
      const ks = Object.keys(cnt).map(Number);
      if (ks.length === 2) {
        const [a, b] = ks;
        if (cnt[a] === 3 && cnt[b] === 2) return { type: 'triple2', n: 5, value: ovRank(a, level) };
        if (cnt[b] === 3 && cnt[a] === 2) return { type: 'triple2', n: 5, value: ovRank(b, level) };
      }
    }
    if (cs.some(c => c.rank >= JOKER_S)) return null;  // 王(及被当作王的百搭)不进序列
    // 序列类: 在 A=14 与 A=1 两种标尺上检查
    for (const aLow of [false, true]) {
      const m = vals.map(v => (v === 14 && aLow) ? 1 : v);
      const uniq = [...new Set(m)];
      uniq.sort((x, y) => x - y);
      if (n === 5) { // 顺子/同花顺
        if (uniq.length === 5 && uniq[4] - uniq[0] === 4) {
          const suits = new Set(cs.map(c => c.suit));
          if (suits.size === 1) return { type: 'sf', n: 5, value: uniq[4], suit: cs[0].suit };
          return { type: 'straight', n: 5, value: uniq[4] };
        }
      }
      if (n === 6) { // 三连对(木板): 必须且只能是三连对, 不可以二连对/四连对
        if (uniq.length === 3 && uniq[2] - uniq[0] === 2 && vals.every(v => cntOf(vals, v) === 2))
          return { type: 'pairseq', n: 6, value: uniq[2] };
      }
      if (n === 6) { // 三同连张(钢板): 必须且只能是二连三, 不可以三连三
        if (uniq.length === 2 && uniq[1] - uniq[0] === 1 && vals.every(v => cntOf(vals, v) === 3))
          return { type: 'plate', n: 6, value: uniq[1] };
      }
    }
    return null;
    function cntOf(arr, v) { let c = 0; for (const x of arr) if (x === v) c++; return c; }
  }

  /* 百搭赋值方案: natural(自身级点) 优先, 其余枚举 2..A */
  function wildAssignments(nWild) {
    if (nWild === 0) return [[]];
    const out = [];
    const ranks = []; for (let r = 2; r <= 14; r++) ranks.push(r);
    if (nWild === 1) { for (const r of ranks) out.push([r]); return out; }
    for (const a of ranks) for (const b of ranks) out.push([a, b]);
    return out;
  }

  /* 把选中的牌解释为牌型; req 为需压过的 Combo(可空=自由出)
   * 多解时取"最强"解释(炸弹>同花顺>大牌型); 返回 Combo 或 null */
  function interpret(cards, level, req) {
    if (!cards || !cards.length) return null;
    const wilds = [], reals = [];
    for (const c of cards) (isWild(c, level) ? wilds : reals).push(c);
    const results = [];
    for (const asg of wildAssignments(wilds.length)) {
      const cs = reals.concat(wilds.map((w, i) => ({ rank: asg[i], suit: w.suit, id: w.id })));
      const p = patternOf(cs, level);
      if (p) { p.cards = cards.slice(); p.usedWild = wilds.length; results.push(p); }
    }
    if (!results.length) return null;
    const seen = new Set(), uniq = [];
    for (const r of results) {
      const k = r.type + '|' + r.n + '|' + r.value + '|' + (r.suit || '');
      if (!seen.has(k)) { seen.add(k); uniq.push(r); }
    }
    uniq.sort((a, b) => strength(b) - strength(a));
    if (req) {
      const base = req.combo || req;
      const ok = uniq.filter(c => beats(c, base));
      return ok.length ? ok[0] : null;
    }
    return uniq[0];
  }

  /* ---------- 走牌生成 ---------- */
  function countByRank(cards) {
    const m = new Map();
    for (const c of cards) { if (!m.has(c.rank)) m.set(c.rank, []); m.get(c.rank).push(c); }
    return m;
  }

  /* 从手牌取某 rank 的 cnt 张: 优先非百搭 */
  function takeRank(byRank, rank, cnt, usedIds) {
    const list = (byRank.get(rank) || []).filter(c => !usedIds.has(c.id));
    const real = list.filter(c => !c.wildAs && !c.isWildSrc);
    // 注意: 手牌里的牌是原始牌, 百搭判需 level; 调用方已保证
    const pick = list.slice(0, cnt);
    if (pick.length < cnt) return null;
    for (const c of pick) usedIds.add(c.id);
    return pick;
  }

  /* 生成手牌所有合法出牌 (req=null 为领出全部候选; 否则仅能压过的) */
  function genMoves(hand, level, req) {
    const res = [], seen = new Set();
    const push = c => { const k = c.type + '|' + c.n + '|' + c.value + '|' + (c.suit || ''); if (!seen.has(k)) { seen.add(k); res.push(c); } };
    const byRank = countByRank(hand);
    const wildCards = hand.filter(c => isWild(c, level));
    const nWild = wildCards.length;

    // 单张: 每个不同比较值出一张(级牌优先用真级牌, 百搭留着配牌)
    const ovRep = new Map();
    for (const c of hand) {
      const v = ov(c, level);
      const cur = ovRep.get(v);
      if (!cur) ovRep.set(v, c);
      else if (!isWild(c, level) && isWild(cur, level)) ovRep.set(v, c);
    }
    for (const [v, c] of ovRep) push({ type: 'single', n: 1, value: v, cards: [c] });
    // 对子/三张/炸弹
    for (const [rank, list] of byRank) {
      const total = list.length;
      const v = ovRank(rank, level);
      if (rank >= JOKER_S) { if (total >= 2) { push({ type: 'pair', n: 2, value: v, cards: list.slice(0, 2) }); } continue; }
      if (total + (rank === level ? 0 : nWild) >= 2) {
        const c2 = pickCards(hand, rank, 2, level); if (c2) push({ type: 'pair', n: 2, value: v, cards: c2 });
      }
      if (total + (rank === level ? 0 : nWild) >= 3) {
        const c3 = pickCards(hand, rank, 3, level); if (c3) push({ type: 'triple', n: 3, value: v, cards: c3 });
      }
      for (let b = 4; b <= Math.min(10, total + (rank === level ? 0 : nWild)); b++) {
        const cb = pickCards(hand, rank, b, level); if (cb) push({ type: 'bomb', n: b, value: v, cards: cb });
      }
    }
    // 三带二
    const tripleRanks = [], pairRanks = [];
    for (const [rank, list] of byRank) {
      if (rank >= JOKER_S) continue;
      const avail = list.length + (rank === level ? 0 : nWild);
      if (avail >= 3) tripleRanks.push(rank);
      if (avail >= 2) pairRanks.push(rank);
    }
    for (const t of tripleRanks) for (const p of pairRanks) {
      if (p === t) continue;
      const used = new Set();
      const ct = pickCards(hand, t, 3, level, used); if (!ct) continue;
      const cp = pickCards(hand, p, 2, level, used); if (!cp) continue;
      push({ type: 'triple2', n: 5, value: ovRank(t, level), cards: ct.concat(cp) });
    }
    // 序列类窗口
    for (let s = 1; s <= 10; s++) { // 顺子: 1=A2345 ... 10=10JQKA
      const w = windowRanks(s, 5);
      const cs = pickWindow(hand, w, 1, level); if (cs) push({ type: 'straight', n: 5, value: s + 4, cards: cs });
    }
    for (let s = 1; s + 2 <= 14; s++) { // 三连对: 只能3对
      const w = windowRanks(s, 3);
      const cs = pickWindow(hand, w, 2, level); if (cs) push({ type: 'pairseq', n: 6, value: s + 2, cards: cs });
    }
    for (let s = 1; s + 1 <= 14; s++) { // 钢板: 只能二连三
      const w = windowRanks(s, 2);
      const cs = pickWindow(hand, w, 3, level); if (cs) push({ type: 'plate', n: 6, value: s + 1, cards: cs });
    }
    // 同花顺: 每花色窗口(百搭是红桃, 只能配红桃窗口)
    for (const s of SUITS) {
      const suitCards = hand.filter(c => c.suit === s);
      if (suitCards.length + (s === 'H' ? nWild : 0) < 5) continue;
      const suitByRank = countByRank(suitCards);
      for (let st = 1; st <= 10; st++) {
        const w = windowRanks(st, 5);
        const cs = pickWindow(suitCards, w, 1, level, s === 'H' ? wildCards : []);
        if (cs) push({ type: 'sf', n: 5, value: st + 4, suit: s, cards: cs });
      }
    }
    // 四大天王
    const js = hand.filter(c => c.rank === JOKER_S), jb = hand.filter(c => c.rank === JOKER_B);
    if (js.length === 2 && jb.length === 2) push({ type: 'rocket', n: 4, value: 100, cards: js.concat(jb) });

    // 过滤: 必须压过 req
    const base = req && (req.combo || req);
    const legal = base ? res.filter(c => beats(c, base)) : res;
    return legal;
  }

  function windowRanks(s, k) {
    // s=1 表示 A(14)作1 起头: A,2,3,...; 其余 s..s+k-1
    const w = [];
    for (let i = 0; i < k; i++) { let r = s + i; if (r === 1) r = 14; w.push(r); }
    return w;
  }

  /* 从 cards 中为窗口每个 rank 取 need 张; wildExtra 为可用的百搭(仅红桃窗口) */
  function pickWindow(cards, ranks, need, level, wildExtra) {
    const byRank = countByRank(cards);
    const used = new Set();
    const out = [];
    let wilds = wildExtra !== undefined ? wildExtra : cards.filter(c => isWild(c, level));
    for (const r of ranks) {
      const list = (byRank.get(r) || []).filter(c => !used.has(c.id) && !isWild(c, level));
      let take = list.slice(0, need);
      let short = need - take.length;
      if (short > 0) {
        const w = wilds.filter(c => !used.has(c.id)).slice(0, short);
        short -= w.length;
        take = take.concat(w);
      }
      if (short > 0) return null;
      for (const c of take) used.add(c.id);
      out.push(...take);
    }
    return out;
  }

  /* 按 rank 取 cnt 张(优先非百搭) */
  function pickCards(cards, rank, cnt, level, usedSet) {
    const used = usedSet || new Set();
    const list = cards.filter(c => c.rank === rank && !used.has(c.id));
    const real = list.filter(c => !isWild(c, level));
    const pick = real.slice(0, cnt);
    if (pick.length < cnt) {
      const w = list.filter(c => isWild(c, level)).slice(0, cnt - pick.length);
      pick.push(...w);
    }
    if (pick.length < cnt) return null;
    if (!usedSet) for (const c of pick) used.add(c.id);
    else for (const c of pick) used.add(c.id);
    return pick;
  }

  /* ---------- 记牌: 场上未现牌统计 ---------- */
  /* 对 seat 而言: 108 - 自己手牌 - 本局已打出的牌 = 他人手中 + 底? (掼蛋无底牌) */
  function unseenInfo(game, seat) {
    const total = new Map();
    for (let r = 2; r <= 14; r++) total.set(r, 8);
    total.set(JOKER_S, 2); total.set(JOKER_B, 2);
    const dec = cards => { for (const c of cards) total.set(c.rank, total.get(c.rank) - 1); };
    dec(game.hands[seat]); dec(game.playedAll);
    const byRank = {}; for (const [r, n] of total) byRank[r] = n;
    // 炸弹风险: 未现≥4 的点数
    const bombRisk = [];
    for (let r = 2; r <= 14; r++) if (byRank[r] >= 4) bombRisk.push(r);
    return { byRank, bombRisk, jokersLeft: byRank[JOKER_S] + byRank[JOKER_B] };
  }

  /* ---------- 对局状态机 ---------- */
  const RANKS_ALL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  function levelStr(level) { return RANKS_ALL[level - 2]; }

  class Game {
    constructor(opts) {
      opts = opts || {};
      this.difficulty = opts.difficulty || 'medium';
      this.userSeat = opts.userSeat == null ? 0 : opts.userSeat;
      this.newMatch(opts.startLevel || 2);
    }
    teamOf(seat) { return seat % 2; }
    partnerOf(seat) { return (seat + 2) % 4; }

    newMatch(startLevel) {
      this.level = startLevel || 2;
      this.handNo = 0;
      this.matchOver = false;
      this.winTeam = -1;
      this.handsWon = [[], []];  // 每队赢的局记录
      this.newHand();
    }

    newHand() {
      this.handNo++;
      this.phase = 'play';
      this.outOrder = [];
      this.playedAll = [];              // 本局所有已出牌(公开)
      this.playLog = [];                // {seat, combo|null(pass), desc, handsLeft}
      this.playedBy = [[], [], [], []]; // 各家出过的 combo
      this.passedBy = [[], [], [], []]; // 各家"不要"记录 (牌型type)
      this.trick = null;                // {combo, seat}
      this.passCount = 0;
      this.tribute = null;              // {payers:[{seat,card}], returns, leader}

      const deck = shuffle(makeDeck());
      this.hands = [[], [], [], []];
      for (let i = 0; i < 108; i++) this.hands[i % 4].push(deck[i]);
      for (let s = 0; s < 4; s++) sortHand(this.hands[s], this.level);

      if (this.handNo === 1) {
        this.leader = Math.floor(Math.random() * 4);  // 首局翻牌定先手(简化为随机)
        this.turn = this.leader;
      } else {
        this.setupTribute();
      }
      this.log('—— 第' + this.handNo + '局 打' + levelStr(this.level) + ' ——');
    }

    /* 上局结果 → 本局贡牌安排 */
    setupTribute() {
      const r = this.lastResult;
      const losers = [r.third, r.fourth];      // 出局顺序的第3、4名
      const winners = [r.first, r.second];
      let payers, leadSeat;
      if (this.teamOf(r.first) === this.teamOf(r.second)) {
        // 双下: 双贡
        payers = losers.slice();
      } else {
        payers = [r.fourth];                    // 单下: 末游进贡
      }
      // 抗贡(国家规则): 双贡时任一家抓到两张大王, 则双下方都不用进贡; 单贡同理
      const anyTwoKings = payers.some(s => this.hands[s].filter(c => c.rank === JOKER_B).length >= 2);
      const realPayers = anyTwoKings ? [] : payers.slice();
      if (realPayers.length === 0) {
        this.tribute = { payers: [], resisted: true, resistSeats: payers.slice(), leader: r.first };
        this.leader = r.first; this.turn = r.first;
        this.phase = 'play';
        return;
      }
      // 单贡: 贡给头游; 双贡: 大贡给头游, 小贡给二游
      const giveTo = {};
      if (realPayers.length === 1) giveTo[realPayers[0]] = r.first;
      else {
        // 双贡: 比较两人将贡出的牌点大小(此时已知手牌, 由AI/规则取最大)
        const c0 = this.maxTributeCard(realPayers[0]);
        const c1 = this.maxTributeCard(realPayers[1]);
        const big = ov(c0, this.level) >= ov(c1, this.level) ? realPayers[0] : realPayers[1];
        const small = big === realPayers[0] ? realPayers[1] : realPayers[0];
        giveTo[big] = r.first; giveTo[small] = r.second;
      }
      this.tribute = { payers: realPayers, giveTo, returns: {}, resisted: false, doneGive: false, doneReturn: false };
      // 进贡执行(自动选牌, 规则固定: 牌点最大、红桃级牌除外)
      for (const s of realPayers) {
        const card = this.maxTributeCard(s);
        this.hands[s] = this.hands[s].filter(c => c.id !== card.id);
        this.hands[giveTo[s]].push(card);
        this.tribute.returns[s] = card;
      }
      for (const s of [0, 1, 2, 3]) sortHand(this.hands[s], this.level);
      // 还牌(≤10) —— 若收贡者为用户则等 UI; AI 自动
      this.phase = 'tribute';
      const userGives = realPayers.includes(this.userSeat);
      const userReturns = realPayers.some(s => this.teamOf(giveTo[s]) === this.teamOf(this.userSeat) && giveTo[s] === this.userSeat);
      if (!userReturns) this.aiReturnTribute();
      else return; // 等用户还贡
      this.finishTribute();
    }

    maxTributeCard(seat) {
      let best = null;
      for (const c of this.hands[seat]) {
        if (isWild(c, this.level)) continue;          // 红桃级牌不进贡
        if (!best || ov(c, this.level) > ov(best, this.level)) best = c;
      }
      return best;
    }

    aiReturnTribute() {
      // 收贡者还牌(国家规则: 还给对方可任意牌; 策略上仍还最小且不拆对的牌)
      for (const s of this.tribute.payers) {
        const receiver = this.tribute.giveTo[s];
        if (receiver === this.userSeat) continue; // 用户稍后手动还
        const cands = this.hands[receiver].slice();
        if (!cands.length) { this.tribute.returns[receiver] = null; continue; }
        // 选: 点最小且不破坏对子/三张的
        const byRank = countByRank(this.hands[receiver]);
        cands.sort((a, b) => {
          const pa = byRank.get(a.rank).length, pb = byRank.get(b.rank).length;
          return (a.rank - b.rank) || (pa - pb);
        });
        const pick = cands.find(c => byRank.get(c.rank).length === 1) || cands[0];
        this.hands[receiver] = this.hands[receiver].filter(c => c.id !== pick.id);
        this.hands[s].push(pick);
        this.tribute.returns[receiver] = pick;
      }
      for (let s = 0; s < 4; s++) sortHand(this.hands[s], this.level);
    }

    /* 用户选择还贡后调用 */
    userReturnTribute(card) {
      const rec = this.userSeat;
      const payer = this.tribute.payers.find(s => this.tribute.giveTo[s] === rec);
      this.hands[rec] = this.hands[rec].filter(c => c.id !== card.id);
      this.hands[payer].push(card);
      this.tribute.returns[rec] = card;
      sortHand(this.hands[rec], this.level); sortHand(this.hands[payer], this.level);
      this.aiReturnTribute();
      this.finishTribute();
    }

    finishTribute() {
      // 领出者: 有实际进贡时由"进贡给头游者"领出; 全抗贡由头游领出
      let leader;
      if (this.tribute.resisted) leader = this.lastResult.first;
      else {
        const payerToFirst = this.tribute.payers.find(s => this.tribute.giveTo[s] === this.lastResult.first);
        leader = payerToFirst != null ? payerToFirst : this.lastResult.first;
      }
      this.leader = leader; this.turn = leader;
      this.phase = 'play';
    }

    /* 校验 seat 想出的 cards */
    legalCheck(seat, cards) {
      if (this.phase !== 'play') return { ok: false, err: '当前不能出牌' };
      if (seat !== this.turn) return { ok: false, err: '还没轮到你' };
      const ids = new Set(cards.map(c => c.id));
      if (ids.size !== cards.length) return { ok: false, err: '牌重复' };
      const mine = new Set(this.hands[seat].map(c => c.id));
      for (const c of cards) if (!mine.has(c.id)) return { ok: false, err: '有不在你手里的牌' };
      if (this.trick && this.trick.seat !== seat) {
        const combo = interpret(cards, this.level, this.trick.combo);
        if (!combo) {
          const any = interpret(cards, this.level, null);
          if (!any) return { ok: false, err: '不成牌型' };
          return { ok: false, err: '压不过 ' + comboDesc(this.trick.combo, this.level) };
        }
        return { ok: true, combo };
      }
      const combo = interpret(cards, this.level, null);
      if (!combo) return { ok: false, err: '不成牌型' };
      return { ok: true, combo };
    }

    /* 出牌 / 不要(cards=null) */
    play(seat, cards) {
      if (cards && cards.length) {
        const chk = this.legalCheck(seat, cards);
        if (!chk.ok) return chk;
        const combo = chk.combo;
        const ids = new Set(cards.map(c => c.id));
        this.hands[seat] = this.hands[seat].filter(c => !ids.has(c.id));
        this.playedAll.push(...cards);
        this.trick = { combo, seat, cards: cards.slice() };
        this.passCount = 0;
        this.playLog.push({ seat, combo, cards: cards.slice(), pass: false, handsLeft: this.hands.map(h => h.length) });
        this.playedBy[seat].push(combo);
        if (this.hands[seat].length === 0) {
          this.outOrder.push(seat);
          // 双下: 前两名同队 → 立即结束
          if (this.outOrder.length === 2 && this.teamOf(this.outOrder[0]) === this.teamOf(this.outOrder[1])) {
            this.endHand(); return { ok: true };
          }
          if (this.outOrder.length >= 3) { this.endHand(); return { ok: true }; }
        }
        this.turn = this.nextAlive(seat);
      } else {
        this.playLog.push({ seat, pass: true, combo: null, handsLeft: this.hands.map(h => h.length) });
        this.passedBy[seat].push(this.trick ? this.trick.combo.type : null);
        this.passCount++;
        // 一圈结束条件: 自上次出牌后, 其余有牌玩家都已"不要"
        const aliveCount = this.hands.reduce((a, h) => a + (h.length > 0 ? 1 : 0), 0);
        if (this.passCount >= Math.max(1, aliveCount - 1)) {
          // 一圈结束
          const winner = this.trick.seat;
          this.trick = null;
          this.passCount = 0;
          if (this.hands[winner].length === 0) {
            // 接风: 同伴领出; 同伴已出完则顺延
            let next = this.partnerOf(winner);
            if (this.hands[next].length === 0) next = this.nextAlive(winner);
            this.turn = next;
          } else {
            this.turn = winner;
          }
        } else {
          this.turn = this.nextAlive(seat);
        }
      }
      return { ok: true };
    }

    nextAlive(seat) {
      let s = seat;
      for (let i = 0; i < 4; i++) {
        s = (s + 1) % 4;
        if (this.hands[s].length > 0) return s;
      }
      return seat;
    }

    endHand() {
      const ranks = this.outOrder.slice();          // 已确定的名次
      const rest = [];
      for (let s = 0; s < 4; s++) if (!ranks.includes(s)) rest.push(s);
      rest.sort((a, b) => this.hands[a].length - this.hands[b].length); // 剩牌少者列前
      ranks.push(...rest);
      const first = ranks[0];
      const partner = this.partnerOf(first);
      const partnerRank = ranks.indexOf(partner) + 1;   // 1~4
      const winTeam = this.teamOf(first);
      let inc = partnerRank === 2 ? 3 : partnerRank === 3 ? 2 : 1;
      let passedA = false, stayA = false;
      if (this.level === 14) {
        if (partnerRank === 2 || partnerRank === 3) { passedA = true; this.matchOver = true; this.winTeam = winTeam; }
        else stayA = true;
      }
      const newLevel = this.matchOver ? this.level : Math.min(14, this.level + inc);
      this.lastResult = {
        ranks, first, second: ranks[1], third: ranks[2], fourth: ranks[3],
        winTeam, inc, newLevel, passedA, stayA,
        isDoubleDown: this.teamOf(ranks[0]) === this.teamOf(ranks[1]),
        双下: this.teamOf(ranks[0]) === this.teamOf(ranks[1])
      };
      this.level = newLevel;
      this.phase = 'handEnd';
    }

    nextHand() { if (!this.matchOver) this.newHand(); }

    log(msg) { (this.logs = this.logs || []).push(msg); }
  }

  /* ---------- 残局/习题装载 ---------- */
  function loadCustom(hands, level, leader) {
    const g = new Game({ startLevel: level });
    g.handNo = 2; // 跳过随机先手逻辑
    for (let s = 0; s < 4; s++) g.hands[s] = sortHand(hands[s].slice(), level);
    g.playedAll = []; g.outOrder = []; g.playLog = []; g.playedBy = [[], [], [], []]; g.passedBy = [[], [], [], []];
    g.trick = null; g.passCount = 0; g.phase = 'play';
    g.leader = leader == null ? 0 : leader; g.turn = g.leader;
    g.lastResult = { first: 0, second: 1, third: 2, fourth: 3 }; // 防止 tribute 报错
    return g;
  }

  GD.engine = {
    SUITS, JOKER_S, JOKER_B, RANK_STR, SUIT_STR, RED_SUITS, TYPE_NAME, RANKS_ALL,
    makeDeck, isWild, isJoker, ov, ovRank, cname, cnames, sortHand, shuffle,
    interpret, patternOf, genMoves, beats, tier, bombWeight, strength, comboDesc,
    countByRank, unseenInfo, levelStr,
    Game, loadCustom
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD;
})(typeof window !== 'undefined' ? window : globalThis);
