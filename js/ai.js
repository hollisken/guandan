/* ============================================================
 * 掼蛋训练器 - AI + 教练层 (ai.js)
 *
 * 设计思路(参照 DouZero 的"出牌存活率评估" + 专家规则库):
 *  - DouZero 用自我博弈训练网络评估每个动作的价值; 我们用可解释的
 *    特征评分替代黑盒网络: 每个候选出牌提取「手数/控牌/风险/配合/
 *    报牌压力」等特征加权打分, 分数即讲解 —— 这是教学型AI的关键取舍:
 *    牌力略逊于深度RL, 但每一手都能说清"为什么"。
 *  - 拆牌(decompose)目标: 最少手数 + 保留炸弹与逢人配的灵活性。
 *  - 记牌: 引擎 unseenInfo 给出未现牌统计, 用于估算"这手牌会不会被
 *    后面的人压" —— 即 DouZero 意义上的存活率。
 * ============================================================ */
(function (root) {
  'use strict';
  const GD = (root.GD = root.GD || {});
  const E = GD.engine;

  const SEAT_NAME = ['你(南)', '下家(东)', '对家(北·同伴)', '上家(西)'];
  function seatName(seat, userSeat) {
    const d = (seat - userSeat + 4) % 4;
    return ['你', '下家', '对家(同伴)', '上家'][d];
  }
  function relName(seat, userSeat) {
    const d = (seat - userSeat + 4) % 4;
    return ['你', '下家', '对家', '上家'][d];
  }

  /* ---------------- 动态配牌语境(组牌随对手牌路变化 — 掼蛋精粹) ---------------- */
  /* 从最近出牌推断该用什么倾向重组手牌:
   *  - 对手连跑单张路 → 对子是阻击弹药, 组牌惜对(pairBias+)
   *  - 对手对子路示弱(多次不要对) → 对子/三连对是得分路, 更不能拆(pairBias+)
   *  - 同伴在对子路 → 保护对子结构(pairBias+) */
  function decomposeCtx(g, seat) {
    let pairBias = 0;
    if (!g || !g.playLog) return { pairBias, why: '' };
    const nonPass = [];
    for (let i = g.playLog.length - 1; i >= 0 && nonPass.length < 8; i--) if (!g.playLog[i].pass) nonPass.push(g.playLog[i]);
    const oppLedSingles = nonPass.filter(e => g.teamOf(e.seat) !== g.teamOf(seat) && e.combo.type === 'single').length;
    let oppPassedPairs = 0;
    for (let s = 0; s < 4; s++) if (g.teamOf(s) !== g.teamOf(seat)) oppPassedPairs += (g.passedBy[s] || []).filter(t => t === 'pair').length;
    const why = [];
    if (oppLedSingles >= 2) { pairBias += 5; why.push('对手在跑单张路——对子是阻击弹药, 组牌更要惜对'); }
    if (oppPassedPairs >= 2) { pairBias += 4; why.push('对手对子已示弱(多次不要对)——对子/三连对是你的得分路, 别拆散'); }
    return { pairBias, why: why.join('；') };
  }

  /* ---------------- 拆牌: 最少手数(带动态语境) ---------------- */
  /* 返回 {hands:[Combo...], count}  Combo同引擎格式; 百搭牌不进自然池, 由第8步专门配并 */
  function decompose(hand, level, ctx) {
    const bias = (ctx && ctx.pairBias) || 0;
    const pool = hand.filter(c => !E.isWild(c, level)).map(c => ({ id: c.id, rank: c.rank, suit: c.suit }));
    const wilds = hand.filter(c => E.isWild(c, level)).map(c => ({ id: c.id, rank: c.rank, suit: c.suit }));
    const out = [];
    const used = new Set();
    const avail = () => pool.filter(c => !used.has(c.id));
    const byRankN = () => { const m = new Map(); for (const c of avail()) { if (!m.has(c.rank)) m.set(c.rank, []); m.get(c.rank).push(c); } return m; };
    const take = (list, k) => { const t = list.slice(0, k); for (const c of t) used.add(c.id); return t; };

    // 1. 四大天王
    const jokers = avail().filter(c => c.rank >= E.JOKER_S);
    if (jokers.filter(c => c.rank === 15).length === 2 && jokers.filter(c => c.rank === 16).length === 2) {
      out.push({ type: 'rocket', n: 4, value: 100, cards: jokers.slice() });
      jokers.forEach(c => used.add(c.id));
    }
    // 2. 天然炸弹(≥4张, 不用百搭)
    {
      const m = byRankN();
      for (const [rank, list] of m) {
        if (rank >= E.JOKER_S || list.length < 4) continue;
        const cards = take(list, list.length);
        out.push({ type: 'bomb', n: cards.length, value: E.ovRank(rank, level), cards });
      }
    }
    // 3. 顺子/同花顺: 贪心, 每窗口取破坏最小的组合。
    //    组牌要诀: ①同花顺"算总账"值得拆小对(一手清5张还能压炸); ②拆对惜对由语境bias调节;
    //    ③"长套组小套, 单张最大化"——同破坏时留点数大的单在外(级牌ov最高自动留下)
    for (let iter = 0; iter < 6; iter++) {
      let best = null;
      for (let st = 1; st <= 10; st++) {
        const ranks = winRanks(st, 5);
        const m = byRankN();
        if (!ranks.every(r => (m.get(r) || []).length >= 1)) continue;
        const pairBreak = r => { const cnt = (m.get(r) || []).length; return cnt <= 1 ? 0 : (cnt === 2 ? 3 + E.ovRank(r, level) * 0.5 + bias : 6 + E.ovRank(r, level)); };
        // a) 同花顺: 任一花色五张齐
        for (const s of E.SUITS) {
          const picks = ranks.map(r => (m.get(r) || []).find(c => c.suit === s));
          if (!picks.every(Boolean)) continue;
          let p = -12;
          for (const c of picks) p += pairBreak(c.rank);
          if (ranks.includes(level)) p += 2;   // 同花顺里含级牌更值
          if (!best || p < best.penalty) best = { st, penalty: p, ranks, sf: true, cards: picks };
        }
        // b) 普通顺子: 每rank一张
        let p = 0;
        for (const r of ranks) {
          p += pairBreak(r);
          if (r === level && (m.get(r) || []).length === 2) p += 4;  // 保护级牌对(可配炸)
        }
        // 长套组小套: 窗口外相邻端点(被留下的单张)点越大越好, 级牌ov15自动优先留下
        let leftoverOv = 0;
        for (const cand of [ranks[0] - 1, ranks[4] + 1]) {
          const rr = cand === 1 ? 14 : cand;
          if (rr >= 2 && rr <= 14 && !ranks.includes(rr) && (m.get(rr) || []).length >= 1) leftoverOv = Math.max(leftoverOv, E.ovRank(rr, level));
        }
        p -= leftoverOv * 0.4;
        if (!best || p < best.penalty) best = { st, penalty: p, ranks };
      }
      if (!best || best.penalty > 16) break;
      if (best.cards) {
        best.cards.forEach(c => used.add(c.id));
        out.push({ type: 'sf', n: 5, value: best.st + 4, suit: best.cards[0].suit, cards: best.cards });
      } else {
        const m = byRankN();
        const cards = [];
        for (const r of best.ranks) { const c = m.get(r)[0]; used.add(c.id); cards.push(c); }
        out.push({ type: 'straight', n: 5, value: best.st + 4, cards });
      }
    }
    // 5. 三连对(规则: 只能3对), 拆三张重罚
    {
      const k = 3;
      for (let iter = 0; iter < 4; iter++) {
        let best = null;
        for (let st = 1; st + k - 1 <= 14; st++) {
          const ranks = winRanks(st, k);
          const m = byRankN();
          if (!ranks.every(r => (m.get(r) || []).length >= 2)) continue;
          let penalty = 0;
          for (const r of ranks) { const cnt = m.get(r).length; if (cnt > 2) penalty += 14 + E.ovRank(r, level) * 2; if (r === level) penalty += 5; }
          if (!best || penalty < best.penalty) best = { st, penalty, ranks, k };
        }
        if (!best || best.penalty > 22) break;
        const m = byRankN();
        const cards = [];
        for (const r of best.ranks) { const cs = m.get(r).slice(0, 2); cs.forEach(c => used.add(c.id)); cards.push(...cs); }
        out.push({ type: 'pairseq', n: 6, value: best.st + 2, cards });
      }
    }
    // 6. 三张 → 三带二
    {
      const m = byRankN();
      const triples = [], pairs = [];
      for (const [rank, list] of m) {
        if (rank >= E.JOKER_S) continue;
        if (list.length >= 3) triples.push(rank); else if (list.length === 2) pairs.push(rank);
      }
      for (const t of triples) {
        const list = m.get(t);
        const cards = take(list, 3);
        out.push({ type: 'triple', n: 3, value: E.ovRank(t, level), cards });
      }
      // 只给最小的三张配对(避免拆高对)
      if (triples.length && pairs.length) {
        const t = triples.slice().sort((a, b) => E.ovRank(a, level) - E.ovRank(b, level))[0];
        const p = pairs.slice().sort((a, b) => E.ovRank(a, level) - E.ovRank(b, level))[0];
        // 从out里找到该triple, 升级为三带二
        const tri = out.find(o => o.type === 'triple' && o.value === E.ovRank(t, level));
        if (tri) {
          const plist = m.get(p).filter(c => !used.has(c.id)).slice(0, 2);
          if (plist.length === 2) { plist.forEach(c => used.add(c.id)); tri.cards.push(...plist); tri.type = 'triple2'; tri.n = 5; }
        }
      }
    }
    // 7. 剩余对子/单张
    for (let guard = 0; guard < 40; guard++) {
      const m = byRankN();
      let acted = false;
      for (const [rank, list] of m) {
        if (!list.length) continue;
        if (list.length >= 2) {
          const cards = take(list, 2);
          out.push({ type: 'pair', n: 2, value: E.ovRank(rank, level), cards });
        } else {
          used.add(list[0].id);
          out.push({ type: 'single', n: 1, value: E.ov(list[0], level), cards: [list[0]] });
        }
        acted = true; break;
      }
      if (!acted) break;
    }
    // 8. 逢人配合并(百搭已不在自然池): 补顺 > 双散单补三张 > 对子升三张 > 单独出
    for (const wid of wilds.map(w => w.id)) {
      const loose = out.filter(o => o.type === 'single');
      // a) 补顺: 散单凑5连恰缺1 → 百搭补位 (≥2散单并入才算赚)
      let bestW = null;
      for (let st = 1; st <= 10; st++) {
        const ranks = winRanks(st, 5);
        const usedLoose = loose.filter(o => ranks.includes(o.cards[0].rank));
        const covered = new Set(usedLoose.map(o => o.cards[0].rank));
        if (covered.size === 4 && usedLoose.length >= 2) {
          const gain = 1 + usedLoose.length;
          if (!bestW || gain > bestW.gain) bestW = { st, ranks, usedLoose, gain };
        }
      }
      if (bestW) {
        for (const o of bestW.usedLoose) out.splice(out.indexOf(o), 1);
        const cards = [];
        for (const r of bestW.ranks) {
          const lo = bestW.usedLoose.find(o => o.cards[0].rank === r);
          if (lo) { cards.push(lo.cards[0]); continue; }
          cards.push({ id: wid, rank: r, suit: 'H', wildFor: r });
        }
        out.push({ type: 'straight', n: 5, value: bestW.st + 4, cards, usedWild: true });
        continue;
      }
      // b) 两散单同点 + 百搭 → 三张 (省2手)
      const cnt = {};
      for (const o of loose) cnt[o.cards[0].rank] = (cnt[o.cards[0].rank] || 0) + 1;
      const triRanks = Object.keys(cnt).map(Number).filter(r => cnt[r] >= 2);
      if (triRanks.length) {
        triRanks.sort((x, y) => E.ovRank(x, level) - E.ovRank(y, level));
        const tr = triRanks[0];
        const used = loose.filter(o => o.cards[0].rank === tr).slice(0, 2);
        for (const o of used) out.splice(out.indexOf(o), 1);
        out.push({ type: 'triple', n: 3, value: E.ovRank(tr, level), cards: [used[0].cards[0], used[1].cards[0], { id: wid, rank: tr, suit: 'H', wildFor: tr }], usedWild: true });
        continue;
      }
      // b2) 对子 + 百搭 → 三张 (省1手, 取值最高的对子)
      const pairs = out.filter(o => o.type === 'pair');
      if (pairs.length) {
        pairs.sort((x, y) => y.value - x.value);
        const p = pairs[0];
        out.splice(out.indexOf(p), 1);
        out.push({ type: 'triple', n: 3, value: p.value, cards: [...p.cards, { id: wid, rank: p.cards[0].rank, suit: 'H', wildFor: p.cards[0].rank }], usedWild: true });
        continue;
      }
      // c) 不合并: 百搭单独作为级牌单张
      out.push({ type: 'single', n: 1, value: 15, cards: [{ id: wid, rank: level, suit: 'H' }] });
    }
    out.sort((a, b) => (b.cards ? b.cards.length : 0) - (a.cards ? a.cards.length : 0));
    return { hands: out, count: out.length };

    /* 合并后 freed 中未入组的牌放回为散单, 防丢牌 */
    function pushLeftoverFreed(cards, freed) {
      const usedIds = new Set(cards.map(c => c.id));
      for (const f of freed) if (!usedIds.has(f.id)) out.push({ type: 'single', n: 1, value: E.ov(f, level), cards: [f] });
    }
  }

  function winRanks(st, k) {
    const w = [];
    for (let i = 0; i < k; i++) { let r = st + i; if (r === 1) r = 14; w.push(r); }
    return w;
  }

  /* 出牌后剩余手数 */
  function afterDecompose(hand, level, moveCards, ctx) {
    const ids = new Set(moveCards.map(c => c.id));
    const rest = hand.filter(c => !ids.has(c.id));
    return decompose(rest, level, ctx);
  }

  /* ---------------- 记牌/风险 ---------------- */
  /* 本圈中已"不要"的座位(自最后一次出牌起) */
  function passedSeats(g) {
    const passed = new Set();
    for (let i = g.playLog.length - 1; i >= 0; i--) {
      const e = g.playLog[i];
      if (e.pass) passed.add(e.seat);
      else break;
    }
    return passed;
  }
  /* 我之后还未表态的座位(按出牌顺序到我之前) */
  function actorsAfter(g, seat) {
    const passed = passedSeats(g);
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const s = (seat + i) % 4;
      if (g.hands[s].length === 0) continue;
      if (passed.has(s)) continue;
      out.push(s);
    }
    return out;
  }
  /* 能压过 combo 的未现牌计数(粗估) */
  function beatersLeft(g, combo) {
    const info = E.unseenInfo(g, g.turn);
    const byRank = info.byRank;
    const cnt = { total: 0, byKind: {} };
    const add = (k, n) => { cnt.byKind[k] = (cnt.byKind[k] || 0) + n; cnt.total += n; };
    if (combo.type === 'rocket') return cnt;
    if (combo.type === 'bomb' || combo.type === 'sf') {
      // 更大炸弹: 点数未现≥combo.n, 或同n更高点; 同花顺; 6+炸压sf
      for (let r = 2; r <= 14; r++) {
        if (byRank[r] > combo.n || (byRank[r] === combo.n && E.ovRank(r, g.level) > combo.value)) add('bomb', 1);
      }
      if (combo.type === 'bomb' && combo.n <= 5) add('sfRisk', Math.min(2, 1)); // 同花顺风险(粗估)
      return cnt;
    }
    if (combo.type === 'single') {
      for (let v = combo.value + 1; v <= 18; v++) {
        // 映射回 rank 数量: v 15/17/18 特殊
        let n = 0;
        if (v === 15) n = byRank[g.level];         // 级牌(非红桃那张才算真单? 简化)
        else if (v === 17) n = byRank[15];
        else if (v === 18) n = byRank[16];
        else {
          // 该值对应的rank(可能=级牌值已排除)
          for (let r = 2; r <= 14; r++) if (E.ovRank(r, g.level) === v) n += byRank[r];
        }
        if (n > 0) add('single' + v, 1);
      }
      return cnt;
    }
    if (combo.type === 'pair') {
      for (let v = combo.value + 1; v <= 15; v++) {
        for (let r = 2; r <= 14; r++) if (E.ovRank(r, g.level) === v && byRank[r] >= 2) add('pair' + v, 1);
      }
      return cnt;
    }
    if (combo.type === 'triple' || combo.type === 'triple2') {
      for (let v = combo.value + 1; v <= 15; v++) {
        for (let r = 2; r <= 14; r++) if (E.ovRank(r, g.level) === v && byRank[r] >= 3) add('triple' + v, 1);
      }
      return cnt;
    }
    // straight/pairseq/plate: 有未现高序列即有风险(粗估: 只要任意更高同型可能)
    for (let v = combo.value + 1; v <= 14; v++) {
      add('seq' + v, 1);
      break;
    }
    return cnt;
  }

  /* ---------------- 特征分析 + 评分 ---------------- */
  function analyzeMove(g, seat, move) {
    const f = { seat, move, notes: [] };
    const hand = g.hands[seat];
    const level = g.level;
    const combo = move;
    const dctx = decomposeCtx(g, seat);          // 动态配牌语境
    const after = afterDecompose(hand, level, combo.cards, dctx);
    f.handCountBefore = decompose(hand, level, dctx).count;
    f.handCountAfter = after.count;
    f.goOut = hand.length - combo.cards.length === 0;
    f.oneLeft = !f.goOut && after.count === 1;
    f.twoLeft = !f.goOut && after.count === 2;
    f.isBombClass = ['bomb', 'sf', 'rocket'].includes(combo.type);
    f.wildSpent = combo.cards.some(c => E.isWild(c, level));

    const actors = actorsAfter(g, seat);
    f.actorsAfter = actors;
    f.oppAfter = actors.filter(s => g.teamOf(s) !== g.teamOf(seat));
    f.partnerAfter = actors.filter(s => g.teamOf(s) === g.teamOf(seat) && s !== seat);
    const trickHolder = g.trick ? g.trick.seat : seat;
    f.leading = !g.trick;
    f.partnerHolds = !f.leading && g.teamOf(trickHolder) === g.teamOf(seat);
    f.selfHolds = !f.leading && trickHolder === seat;

    // 各家剩牌
    f.lefts = g.hands.map(h => h.length);
    f.oppReported = [0, 1, 2, 3].filter(s => g.teamOf(s) !== g.teamOf(seat) && g.hands[s].length <= 2 && g.hands[s].length > 0);
    f.partnerReported = [0, 1, 2, 3].filter(s => g.teamOf(s) === g.teamOf(seat) && s !== seat && g.hands[s].length <= 2 && g.hands[s].length > 0);
    f.urgent = f.oppReported.length > 0 || f.partnerReported.length > 0;   // 报牌紧急态: 允许拆牌抢权
    // 顶牌/阻击语境: 对手领着小单/小对且同伴没接 — 此时不顶就是白送对手牌路
    f.oppHolds = !f.leading && !f.partnerHolds;
    f.contest = f.oppHolds && g.trick && (g.trick.combo.type === 'single' || g.trick.combo.type === 'pair') && g.trick.combo.value <= 10;

    // 存活率: 我出这手后, 对手(未表态者)能否压
    f.beaters = beatersLeft(g, combo);
    f.willSurvive = f.oppAfter.length === 0 || f.beaters.total === 0;
    f.riskHigh = !f.willSurvive && f.beaters.total >= 1;

    // 评分
    let s = 0;
    if (f.wildSpent && ['single', 'pair'].includes(combo.type) && !f.goOut) {
      s -= 600;
      f.notes.push({ k: 'wildWaste', w: -600, t: '逢人配(红桃级牌)是百搭, 单张/对子打出太浪费 —— 留着配顺子、配炸弹价值大得多' });
    }
    if (f.goOut) { s += 100000; f.notes.push({ k: 'goOut', w: 100000, t: '这手出完直接走完(头游/二游), 无条件出!' }); }
    else if (f.oneLeft) { s += 4000; f.notes.push({ k: 'oneLeft', w: 4000, t: '出完这手只剩最后一手牌, 逼近头游' }); }
    else if (f.twoLeft) { s += 800; }

    if (f.isBombClass && !f.goOut) {
      // 炸弹时机: 对手报牌 / 夺权后能连走 / 被逼无奈
      const urgency = f.oppReported.length > 0 ? 3000 : (f.oneLeft ? 2000 : 0);
      s -= 2600 - urgency;
      f.notes.push({ k: 'bombUse', w: -(2600 - urgency), t: urgency ? '对手已报牌, 用炸弹夺权防止其走牌' : '轻易动用炸弹会损失后手威慑力' });
      if (combo.type === 'rocket') { s -= 5000; }
      if (f.leading && !f.oneLeft && !f.twoLeft) {
        s -= 3500;
        f.notes.push({ k: 'leadBomb', w: -3500, t: '领出炸弹是严重浪费——开局没有目标可拦、没有连击路线, 炸弹要留到拦截对手报牌或关键夺权时才用' });
      }
    }
    // 配合: 对家正管着 → 让牌; 绝不炸同伴
    if (f.partnerHolds && !f.goOut) {
      if (f.isBombClass) {
        s -= 6000;
        f.notes.push({ k: 'bombPartner', w: -6000, t: '绝不炸同伴的牌! 同伴正在替你俩抢牌权, 你这一炸除了暴露火力毫无收益' });
      } else {
        const pv = g.trick.combo.value;
        const oppBehind = f.oppAfter.length;
        if (pv >= 11 || oppBehind === 0) {
          s -= 1500;
          f.notes.push({ k: 'yield', w: -1500, t: '对家' + E.comboDesc(g.trick.combo, level) + '已够大, 且不压同伴是基本礼节' });
        } else {
          // 顶牌考量: 同伴牌太小, 后面有对手可能接走
          if (combo.type === 'single' && combo.value >= 12 && combo.value <= 15 && !f.isBombClass) {
            s += 900;
            f.notes.push({ k: 'block', w: 900, t: '同伴牌太小, 用' + E.cname(combo.cards[0], level) + '顶住, 防止下家低价接走' });
          } else s -= 600;
        }
      }
    }
    // 风险: 跟牌时后面对手能压 → 亏; 领出被压无所谓(对手烧大牌, 我方赚)
    // 顶牌语境下按"头顶还剩几档"计价: 顶个中间牌被压就白扔, 顶到位(K/A)只怕级牌王
    if (f.riskHigh && !f.isBombClass && !f.leading) {
      const unit = f.contest ? 150 : 600;
      s -= unit * Math.min(f.contest ? 6 : 3, f.beaters.total);
      if (f.contest) f.notes.push({ k: 'contestSurvive', w: -unit, t: '要顶就顶到对手难压的位置——中间牌被压等于白扔一张' });
    }
    // 顶牌(先大小后中间): 对手领小单/小对且同伴没接, 白送一轮=送牌路; 我是最后防守位时更要顶
    if (f.contest && !f.isBombClass && (combo.type === 'single' || combo.type === 'pair')) {
      s += 800;
      f.notes.push({ k: 'contest', w: 800, t: '顶牌: 对手领小' + (g.trick.combo.type === 'single' ? '单' : '对') + '且同伴未接——放过去他就顺小牌走一圈, 必要时拆对/拆三也要顶' });
      // 打到位: 顶就用手里能压的最大牌(A/K), 留着更小的没意义
      if (combo.type === 'single') {
        const biggerSingle = g.hands[seat].some(c => c.id !== combo.cards[0].id && E.ov(c, level) > combo.value && E.ov(c, level) > g.trick.combo.value);
        if (!biggerSingle) {
          s += 350;
          f.notes.push({ k: 'daodaowei', w: 350, t: '顶就顶到位——这已是你能压的最大单张, 直接打出让级牌/王才压得动' });
        }
      }
      if (f.oppAfter.length === 0) {
        s += 500;
        f.notes.push({ k: 'lastDef', w: 500, t: '你已是最后防守位, 过了这轮对手白得一圈' });
      }
    }
    // 王要省着顶: 用大小王去顶小单/小对是下策(非紧急时)
    if (f.oppHolds && combo.type === 'single' && combo.value >= 17 && g.trick.combo.value <= 10 && !f.urgent && !f.goOut) {
      s -= 400;
      f.notes.push({ k: 'kingReserve', w: -400, t: '王是终局裁判, 拆王顶小单是下策——除非只剩王能压或对手报牌' });
    }
    if (f.willSurvive && (f.oppAfter.length > 0 || !f.leading)) {
      s += 350;
      f.notes.push({ k: 'safe', w: 350, t: '目前未现的牌压不住它, 大概率独走一圈' });
    }
    // 手数成本(报牌紧急态0.3折; 顶牌语境5折——拆对顶单是常规操作)
    const dHands = f.handCountAfter - f.handCountBefore;
    const dhFactor = f.urgent ? 0.3 : (f.contest ? 0.5 : 1);
    s -= dHands * 120 * dhFactor;
    if (dHands > 0) f.notes.push({ k: 'break', w: -dHands * 120 * dhFactor, t: f.urgent
      ? '拆散了原组合(手数+' + dHands + '), 但对手/同伴已报牌——拆牌争取牌权是值得的'
      : f.contest
      ? '拆散了原组合(手数+' + dHands + '), 但顶牌抢权值得——"二个可以拆开来顶单"'
      : '这手拆散了原组合, 手数+' + dHands });
    // 价值消耗: 用大牌干小事亏(顶牌语境下打折——顶就顶到位, 别舍不得)
    if (!f.goOut) {
      const wasteFactor = f.contest ? 0.3 : 1;
      const waste = Math.max(0, combo.value - 10) * (combo.type === 'single' ? 30 : 12) * wasteFactor;
      s -= waste;
      if (waste >= 120) f.notes.push({ k: 'waste', w: -waste, t: '用' + E.cnames(combo.cards.slice(0, 2), level) + (combo.cards.length > 2 ? '等大牌' : '') + '有点浪费, 大牌要留到关键时刻控场' });
    }
    // 喂牌/禁喂(领出时, 区分报单/报双: 单张只能喂单, 对子只能喂双)
    if (f.leading) {
      const pSing = f.partnerReported.find(s => g.hands[s].length === 1);
      const pDbl = f.partnerReported.find(s => g.hands[s].length === 2);
      const oSing = f.oppReported.find(s => g.hands[s].length === 1);
      const oDbl = f.oppReported.find(s => g.hands[s].length === 2);
      if (combo.type === 'single' && combo.value <= 10 && pSing != null) {
        s += 900;
        f.notes.push({ k: 'feed', w: 900, t: '对家报单(剩1张), 领出小单张送他走——即使要拆开对子/三张也在所不惜(助攻要坚决)' });
      }
      if (combo.type === 'pair' && combo.value <= 10 && pDbl != null && pSing == null) {
        s += 900;
        f.notes.push({ k: 'feed', w: 900, t: '对家报双(剩2张), 领出小对子送他走' });
      }
      if (combo.type === 'single' && combo.value <= 8 && (oSing != null || oDbl != null)) {
        s -= 2500;
        f.notes.push({ k: 'denyFeed', w: -2500, t: '对手报牌(剩' + g.hands[(oSing != null ? oSing : oDbl)] + '张), 出小单张正好送他走!' });
      }
      if (combo.type === 'pair' && combo.value <= 8 && oDbl != null) {
        s -= 2500;
        f.notes.push({ k: 'denyFeed', w: -2500, t: '对手报双(剩2张), 出小对子正好送他走——单张他一张接不住' });
      }
      // 控场: 对手报牌时用大单/大对顶住, 不给接牌机会(拆牌争牌权)
      if ((combo.type === 'single' || combo.type === 'pair') && combo.value >= 12 && f.oppReported.length > 0 && !f.isBombClass && !f.goOut) {
        s += 800;
        f.notes.push({ k: 'control', w: 800, t: '对手报牌——领出大' + (combo.type === 'single' ? '单' : '对') + '控场, 不给他接牌机会; 需要时拆开大对/三张也在所不惜' });
      }
      // 领出优先出"自己拆牌里"的组合, 小牌先走
      const dec = decompose(hand, level, dctx);
      const inDec = dec.hands.some(o => o.type === combo.type && o.value === combo.value && o.n === combo.n);
      if (inDec) { s += 250; }
      else if (!f.urgent) { s -= 200; f.notes.push({ k: 'offPlan', w: -200, t: '这手不在你的整体拆牌计划里, 以后要多花一手收回来' }); }
      if ((combo.type === 'triple2' || combo.type === 'plate') && f.lefts.filter(l => l > 10).length === 4) {
        s -= 150; f.notes.push({ k: 'heavyLead', w: -150, t: '开局就领出笨重组, 容易被压, 不如先走散牌' });
      }
      /* ---- 出牌顺序技术(前中期先走小牌/难走的牌, 大牌留控场) ---- */
      const endgame = f.lefts.some((n, idx) => n > 0 && n <= 6);   // 有人进入收官区
      // 逢人配保护: 百搭绝不当首攻单张/对子(除非这手就走完) — "怎么配含金量完全不同"
      if (!f.goOut && !f.oneLeft && !f.twoLeft && combo.cards.some(c => E.isWild(c, level)) && ['single', 'pair'].includes(combo.type)) {
        s -= 2600;
        f.notes.push({ k: 'wildLead', w: -2600, t: '逢人配是百搭精髓——配顺子/配炸弹/留威慑, 含金量天差地别; 绝不能当首攻单张/对子甩出去' });
      }
      if ((combo.type === 'single' || combo.type === 'pair') && !f.goOut && !f.oneLeft && !f.twoLeft) {
        s += Math.max(0, 14 - combo.value) * 45;   // 小牌先走: 值越小越好(散牌是负债)
        if (combo.type === 'single' && combo.value >= 14 && !endgame) {
          s -= 450 + (combo.value - 14) * 200;
          f.notes.push({ k: 'reserve', w: -(450 + (combo.value - 14) * 200), t: 'A/级牌/王是控场牌——前中期领出等于被对手用小牌换掉。"倒数第二大牌先出", 最大的留到收官拦截' });
        }
        // 回手牌技术: 手上有大牌/炸能接回牌权, 先走小牌就不吃亏
        if (combo.value <= 9 && !endgame && dec.hands.some(o => (o.type === 'single' && o.value >= 14) || o.type === 'bomb')) {
          s += 300;
          f.notes.push({ k: 'comeback', w: 300, t: '手上有回手牌(大牌/炸弹)能接回牌权, 先走小牌不吃亏——"先出难走的, 回手再出想出的"' });
        }
      }
      // 难走的手先走(顺子/三带二等长组), 也是"长牌示强"信号
      if (['straight', 'triple2', 'pairseq', 'plate'].includes(combo.type) && inDec && !endgame) {
        s += 180;
        if (combo.cards.length >= 5) f.notes.push({ k: 'strongSignal', w: 180, t: '领出长组示强——告诉同伴这手牌能主攻, 同伴会按辅助打法配合' });
      }
      // 跟同伴牌路(配合): 同伴刚用某型收圈, 继续领同型小牌给他续路
      const lw = [...g.playLog].reverse().find(e => !e.pass);
      if (lw && lw.seat !== seat && g.teamOf(lw.seat) === g.teamOf(seat) &&
          lw.combo.type === combo.type && combo.value <= 10 && (combo.type === 'single' || combo.type === 'pair')) {
        s += 350;
        f.notes.push({ k: 'followPath', w: 350, t: '跟同伴的牌路——同伴刚用' + E.comboDesc(lw.combo, level) + '收圈, 继续领同型小牌给他续路(相互配合)' });
      }
    }
    f.score = s;
    return f;
  }

  function riskDesc(beaters, level) {
    const kinds = Object.keys(beaters.byKind);
    if (!kinds.length) return '';
    return kinds.slice(0, 3).map(k => k.replace(/[0-9]+$/, '')).join('/');
  }

  /* ---------------- PIMC: 完美信息蒙特卡洛(借鉴 paodekuai_ai / GuanZero 思路) ----------------
   * 关键决策时: 随机采样K次对手持牌(与未现牌一致), 每手候选牌用快速贪心策略模拟到终局,
   * 按平均收益(升级收益3/2/1/0)选牌 —— 这是"高级牌手算牌"的算法化, 弥补静态启发式的短板 */
  function samplePimcMove(g, seat, K, movesList) {
    const moves = movesList || E.genMoves(g.hands[seat], g.level, g.trick ? g.trick.combo : null);
    if (moves.length <= 1) return null;
    const info = E.unseenInfo(g, seat);
    const unseen = [];
    for (let r = 2; r <= 16; r++) for (let i = 0; i < (info.byRank[r] || 0); i++) unseen.push({ rank: r, suit: 'S' });
    const others = [0, 1, 2, 3].filter(s => s !== seat && g.hands[s].length > 0);
    const totalOthers = others.reduce((a, s) => a + g.hands[s].length, 0);
    if (unseen.length < totalOthers) return null;
    const score = new Map();
    const key = m => m.type + '|' + m.value + '|' + m.n;
    const KK = K || 10;
    for (let k = 0; k < KK; k++) {
      E.shuffle(unseen);
      const hands = g.hands.map(h => h.slice());
      let ui = 0;
      for (const s of others) {
        for (let i = 0; i < g.hands[s].length && ui < unseen.length; i++) {
          hands[s][i] = { id: 'p' + k + 's' + s + 'i' + i, rank: unseen[ui].rank, suit: unseen[ui].suit };
          ui++;
        }
      }
      for (const m of moves) {
        const ids = new Set(m.cards.map(c => c.id));
        const hs = hands.map((h, idx) => idx === seat ? h.filter(c => !ids.has(c.id)) : h);
        const nextTrick = { combo: { type: m.type, value: m.value, n: m.n, cards: m.cards }, seat };
        let t = (seat + 1) % 4, guard = 0;
        while (hs[t].length === 0 && guard++ < 4) t = (t + 1) % 4;
        const pay = rolloutSim(hs, g.level, nextTrick, t, seat);
        score.set(key(m), (score.get(key(m)) || 0) + pay);
      }
    }
    let best = null;
    const byKey = new Map();
    for (const m of moves) {
      const avg = (score.get(key(m)) || 0) / KK;
      byKey.set(key(m), avg);
      if (!best || avg > best.avg) best = { move: m, avg };
    }
    return { move: best.move, avg: best.avg, samples: KK, avgByKey: byKey };
  }

  /* 快速贪心模拟策略(平均人类水平): 领出最小非炸; 跟牌最小能压; 炸弹仅对手大牌/报牌时用 */
  function rolloutPolicy(sim, s) {
    const moves = E.genMoves(sim.hands[s], sim.level, sim.trick ? sim.trick.combo : null);
    if (!moves.length) return null;
    if (!sim.trick) {
      const nb = moves.filter(m => !['bomb', 'sf', 'rocket'].includes(m.type));
      const pool = nb.length ? nb : moves;
      pool.sort((a, b) => E.strength(a) - E.strength(b));
      return pool[0];
    }
    moves.sort((a, b) => E.strength(a) - E.strength(b));
    const nb = moves.filter(m => !['bomb', 'sf', 'rocket'].includes(m.type));
    if (nb.length) return nb[0];
    const holderOpp = sim.teamOf(sim.trick.seat) !== s % 2;
    let oppLow = false, oppBig = sim.trick.combo.value >= 12;
    for (let i = 0; i < 4; i++) if (sim.hands[i].length > 0 && sim.hands[i].length <= 3 && sim.teamOf(i) !== s % 2) oppLow = true;
    return (holderOpp && (oppBig || oppLow)) ? moves[0] : null;
  }

  /* 模拟到终局, 返回我方视角收益: 头游+同伴二游=3 / 三游=2 / 末游=1; 对方头游=0 */
  function rolloutSim(hands, level, trick, turn, mySeat) {
    const sim = new E.Game({ startLevel: level });
    sim.hands = hands.map(h => h.slice());
    sim.level = level;
    sim.trick = trick ? { combo: trick.combo, seat: trick.seat } : null;
    sim.turn = turn;
    sim.playedAll = []; sim.playLog = []; sim.playedBy = [[], [], [], []]; sim.passedBy = [[], [], [], []];
    sim.outOrder = []; sim.passCount = 0; sim.phase = 'play';
    sim.difficulty = 'hard'; sim.userSeat = mySeat;
    let steps = 0;
    while (sim.phase === 'play' && steps++ < 400) {
      const s = sim.turn;
      const mv = rolloutPolicy(sim, s);
      const r = sim.play(s, mv ? mv.cards : null);
      if (!r.ok) { const pr = sim.play(s, null); if (!pr.ok) break; }
    }
    if (sim.phase !== 'handEnd') return 1;   // 未分胜负按中性
    const r = sim.lastResult;
    if (r.winTeam !== mySeat % 2) return 0;
    const partnerRank = r.ranks.indexOf((mySeat + 2) % 4) + 1;
    return partnerRank === 2 ? 3 : partnerRank === 3 ? 2 : 1;
  }

  /* PIMC触发条件: 高手难度 + 真残局(最短手牌≤10 或 有人报牌≤4) — 早局不算牌(太贵且信息太散) */
  function pimcTriggered(g, moves) {
    if (g.difficulty !== 'hard') return false;
    const minLeft = Math.min(...g.hands.map(h => h.length || 99));
    const reported = [0, 1, 2, 3].some(s => g.hands[s].length > 0 && g.hands[s].length <= 4);
    if (!(minLeft <= 10 || reported)) return false;
    return g.hands[g.turn].length <= 16;   // 手牌太多时模拟成本过高
  }

  /* ---------------- 决策入口 ---------------- */
  function aiMove(g, seat, forceDiff) {
    const moves = E.genMoves(g.hands[seat], g.level, g.trick ? g.trick.combo : null);
    if (!moves.length) return null;
    const diff = forceDiff || g.difficulty || 'medium';
    const analyzed = moves.map(m => analyzeMove(g, seat, m));
    analyzed.sort((a, b) => b.score - a.score);
    // 过牌基准(国家规则: 能压也可选择不要) — 跟牌时若最好的压牌都不如过, 就过
    if (g.trick) {
      const holderOpp = g.teamOf(g.trick.seat) !== g.teamOf(seat);
      const passScore = holderOpp ? -900 : 350; // 同伴在管→让牌很划算; 对手在管→白送一圈有代价
      if (analyzed[0].score < passScore) return null;
    }
    let pick = analyzed[0];
    // PIMC 重排序: 高手难度+关键决策+启发式前几名"势均力敌"(分差<400)时,
    // 用采样模拟(对手持牌随机→模拟到终局→平均升级收益)微调 —— 胶着处才算牌, 教学战术不被覆盖
    if (diff === 'hard' && pimcTriggered(g, moves) && analyzed.length >= 2) {
      const top = analyzed.slice(0, Math.min(4, analyzed.length));
      if (analyzed[0].score - top[top.length - 1].score < 400) {
        try {
          const pimc = samplePimcMove(g, seat, 8, top.map(a => a.move));
          if (pimc) {
            let bestA = top[0], bestV = -Infinity;
            for (const a of top) {
              const avg = pimc.avgByKey.has(a.move.type + '|' + a.move.value + '|' + a.move.n)
                ? pimc.avgByKey.get(a.move.type + '|' + a.move.value + '|' + a.move.n) : 1;
              const v = a.score + avg * 800;
              if (v > bestV) { bestV = v; bestA = a; }
            }
            if (bestA !== analyzed[0]) {
              bestA.notes.push({ k: 'pimc', w: 0, t: '🎲 模拟' + pimc.samples + '局(对手持牌随机采样、模拟到终局): 这几手启发式评分接近, 模拟平均收益更高的这手胜出(' + (pimc.avgByKey.get(bestA.move.type + '|' + bestA.move.value + '|' + bestA.move.n) / 3 * 100).toFixed(0) + '%满收益)' });
            }
            pick = bestA;
          }
        } catch (e) { /* 模拟异常时退回启发式 */ }
      }
    }
    if (diff === 'easy') pick = analyzed[Math.min(analyzed.length - 1, Math.floor(Math.abs(gauss()) * 2))];
    else if (diff === 'medium' && analyzed.length > 1 && Math.random() < 0.12) pick = analyzed[1];
    return { move: pick.move, analysis: pick, all: analyzed };
  }
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /* 教练: 评价用户实际出的牌(或不要) */
  function judgeUserMove(g, seat, comboOrNull) {
    const moves = E.genMoves(g.hands[seat], g.level, g.trick ? g.trick.combo : null);
    const analyzed = moves.map(m => analyzeMove(g, seat, m));
    analyzed.sort((a, b) => b.score - a.score);
    const best = analyzed[0];
    if (comboOrNull == null) {
      // 用户选择不要
      if (!moves.length) return { grade: 'good', head: '只能不要, 正确', notes: [], best: null };
      return { grade: 'ok', head: '你选择了不要', notes: [{ t: '场上还有' + moves.length + '手能压, 但压了也未必划算 —— 关键看: 压完后能不能连续走牌? 用的大牌值不值?' }], best };
    }
    const mine = analyzed.find(a => a.move.type === comboOrNull.type && a.move.value === comboOrNull.value && a.move.n === comboOrNull.n);
    if (!mine) return { grade: 'info', head: '该出牌', notes: [], best };
    const gap = best.score - mine.score;
    if (mine.score === best.score || gap < 80) return { grade: 'good', head: '好手! ' + (mine.notes[0] ? mine.notes[0].t : '与AI首选一致'), notes: mine.notes, best };
    if (gap < 600) return { grade: 'ok', head: '可以, 但有更稳的走法', notes: mine.notes.concat(best.notes.slice(0, 2)), best };
    return { grade: 'bad', head: '这手亏了', notes: mine.notes.concat(best.notes), best };
  }

  /* 教练面板: 记忆要点(判断同伴/对手剩牌) */
  function coachPanel(g, userSeat) {
    const info = E.unseenInfo(g, userSeat);
    const me = g.hands[userSeat].length;
    const pts = [];
    for (let s = 0; s < 4; s++) {
      if (s === userSeat) continue;
      const n = g.hands[s].length;
      const rel = relName(s, userSeat);
      const team = g.teamOf(s) === g.teamOf(userSeat) ? '同伴' : '对手';
      if (n === 0) pts.push(rel + '已出完');
      else if (n <= 2) pts.push('⚠ ' + rel + '(' + team + ')报单! 只剩' + n + '张 —— ' + (team === '对手' ? '绝不给他喂小单张/小对' : '喂小单张/小对送他走'));
      else if (n <= 5) pts.push(rel + '(' + team + ')只剩' + n + '张, 进入危险区');
      else if (n === 10) pts.push(rel + '报牌(剩10张)');
    }
    if (info.jokersLeft > 0) pts.push('大小王还有 ' + info.jokersLeft + ' 张未现' + (info.byRank[16] ? '(大王' + info.byRank[16] + ')' : '') + (info.byRank[15] ? '(小王' + info.byRank[15] + ')' : ''));
    if (info.bombRisk.length) pts.push('炸弹风险点数(未现≥4张): ' + info.bombRisk.map(r => E.RANK_STR[r]).join('、'));
    // 关键历史: 炸弹/王已出
    const bombs = [], jokersPlayed = [];
    for (const e of g.playLog) {
      if (e.pass || !e.combo) continue;
      if (e.combo.type === 'bomb' || e.combo.type === 'sf') {
        const natural = e.combo.cards.find(c => c.rank < 15);
        bombs.push(relName(e.seat, userSeat) + '出了' + e.combo.n + '张' + (natural ? E.RANK_STR[natural.rank] : '') + (e.combo.type === 'sf' ? '同花顺' : '炸'));
      }
      for (const c of e.cards) if (c.rank >= 15) jokersPlayed.push(relName(e.seat, userSeat) + '出' + E.RANK_STR[c.rank]);
    }
    if (bombs.length) pts.push('已见炸弹: ' + bombs.join('; '));
    if (jokersPlayed.length) pts.push('已见王: ' + jokersPlayed.join('; '));
    // 同伴动向
    const partner = g.partnerOf(userSeat);
    if (g.hands[partner].length > 0) {
      const pb = g.playedBy[partner].filter(c => c.type === 'bomb').length;
      pts.push('同伴(对家)剩' + g.hands[partner].length + '张' + (pb ? ', 已用过' + pb + '个炸弹' : ', 炸弹未动') + ' —— 判断他强(能收圈)还是弱(需要你喂牌/顶牌)');
    }
    // 动态配牌方案(随局面变化, 每圈刷新 — 让用户看到组牌是怎么"变"的)
    const dctx = decomposeCtx(g, userSeat);
    const plan = decompose(g.hands[userSeat], g.level, dctx);
    pts.push('📋 当前组牌方案(手数' + plan.count + '): ' + plan.hands.map(h => E.comboDesc(h, g.level)).join(' | ') +
      (dctx.why ? '<br><span style="color:#8a6414">↻ ' + dctx.why + '</span>' : ''));
    return { pts, unseen: info };
  }

  /* 残局静默求解: 给定手牌与局面, 求最佳出牌(用于习题生成) */
  function solveStatic(hands, level, turn, trick, userSeat) {
    const g = {
      level, hands, trick, turn, playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
      teamOf: s => s % 2, partnerOf: s => (s + 2) % 4, userSeat: userSeat == null ? 0 : userSeat, difficulty: 'hard'
    };
    g.unseenInfo = () => E.unseenInfo({ hands, playedAll: [] }, turn);
    const moves = E.genMoves(hands[turn], level, trick);
    const analyzed = moves.map(m => analyzeMove(g, turn, m));
    analyzed.sort((a, b) => b.score - a.score);
    return analyzed;
  }

  GD.ai = {
    SEAT_NAME, seatName, relName,
    decompose, decomposeCtx, afterDecompose, beatersLeft, analyzeMove, aiMove, judgeUserMove, coachPanel, solveStatic,
    passedSeats, actorsAfter
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD;
})(typeof window !== 'undefined' ? window : globalThis);
