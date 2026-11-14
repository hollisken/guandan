/* ============================================================
 * 掼蛋训练器 - 训练模块 (trainer.js)
 *  三类训练:
 *   1) 记牌测验: 在真实对局任意时刻生成选择题, 训练"未现牌/剩牌数"记忆
 *   2) 出牌习题: 随机发牌生成局面, 选最佳出牌, AI给出评分与讲解
 *   3) 精讲残局: 手工设计的典型局面(顶牌/让牌/喂牌/拆炸/收头游/防双下)
 * ============================================================ */
(function (root) {
  'use strict';
  const GD = (root.GD = root.GD || {});
  const E = GD.engine;
  const A = GD.ai;

  function cid() { return 'dr' + Math.random().toString(36).slice(2, 9); }
  /* 简易构造: "S3 H3 x x"  X=大王 x=小王; 返回牌数组 */
  function C(str) {
    const out = [];
    for (const tok of str.split(/\s+/)) {
      if (!tok) continue;
      let s, r, rep = 1, m;
      if ((m = tok.match(/^([Xx])(x(\d))?$/))) { s = 'J'; r = m[1] === 'X' ? 16 : 15; rep = m[3] ? +m[3] : 1; }
      else { m = tok.match(/^([SHDC])(.+?)(x(\d))?$/); s = m[1]; const rr = m[2]; r = rr === 'A' ? 14 : rr === 'K' ? 13 : rr === 'Q' ? 12 : rr === 'J' ? 11 : parseInt(rr); rep = m[4] ? +m[4] : 1; }
      for (let i = 0; i < rep; i++) out.push({ id: cid(), rank: r, suit: s });
    }
    return out;
  }

  /* ---------------- 1. 记牌测验 ---------------- */
  function makeMemoryQuiz(g) {
    const info = E.unseenInfo(g, g.userSeat);
    const kind = Math.floor(Math.random() * 4);
    if (kind === 0) {
      // 未现某点数还剩几张
      const ranks = [];
      for (let r = 2; r <= 14; r++) if (g.hands[g.userSeat].some(c => c.rank === r) || info.byRank[r] > 0) ranks.push(r);
      const r = ranks[Math.floor(Math.random() * ranks.length)];
      const ans = info.byRank[r];
      const opts = [...new Set([ans, Math.max(0, ans - 1), Math.min(8, ans + 1), Math.max(0, ans - 2)])].sort(() => Math.random() - 0.5);
      return { q: `现在场上未现的 ${E.RANK_STR[r]} 还有几张?(你自己手里的不算"未现")`, options: opts.map(String), answer: opts.indexOf(ans), explain: `未现 = 8张(王2张) - 你手里的 - 已打出的。正确答案: ${ans}张。` };
    }
    if (kind === 1) {
      const ans = info.jokersLeft;
      const opts = [...new Set([ans, ans + 1, Math.max(0, ans - 1), Math.min(4, ans + 2)])].sort((a, b) => a - b);
      return { q: '大小王合计还有几张未现?', options: opts.map(String), answer: opts.indexOf(ans), explain: `未现王 = ${ans}张。王的数量决定对手能不能随时压死你 —— 每出一个王都要默念一遍。` };
    }
    if (kind === 2) {
      // 炸弹风险点数
      const risks = info.bombRisk;
      const safes = [];
      for (let r = 2; r <= 14; r++) if (info.byRank[r] < 4 && info.byRank[r] > 0) safes.push(r);
      const safePick = safes[Math.floor(Math.random() * Math.max(1, safes.length))];
      const ansR = risks.length ? risks[Math.floor(Math.random() * risks.length)] : safePick;
      const isRisk = !!risks.length;
      const options = isRisk ? [E.RANK_STR[ansR], E.RANK_STR[safePick], E.RANK_STR[safes[(safes.indexOf(safePick) + 1) % Math.max(1, safes.length)]] || E.RANK_STR[safePick], '没有炸弹风险'] : ['没有炸弹风险', E.RANK_STR[safePick]];
      return { q: '以下哪个点数还有"炸弹风险"(未现≥4张)?', options, answer: isRisk ? 0 : 0, explain: isRisk ? `${E.RANK_STR[ansR]}未现${info.byRank[ansR]}张≥4, 任何一家都可能凑成炸弹。` : '所有点数未现都<4张, 暂无炸弹风险。' };
    }
    // 某家剩几张
    const seat = [1, 2, 3][Math.floor(Math.random() * 3)];
    const rel = A.relName(seat, g.userSeat);
    const ans = g.hands[seat].length;
    const opts = [...new Set([ans, Math.max(1, ans - 1), ans + 1, Math.max(1, ans - 2)])].sort((a, b) => a - b);
    return { q: `${rel}现在手里还剩几张牌?`, options: opts.map(String), answer: opts.indexOf(ans), explain: `${rel}剩${ans}张。${ans <= 2 ? '已报单! 千万别喂小单张/小对。' : ans <= 5 ? '进入危险区, 出牌要收紧。' : '暂时安全。'}` };
  }

  /* ---------------- 2. 出牌习题(随机生成) ---------------- */
  function makePlayDrill() {
    const level = 2 + Math.floor(Math.random() * 13);
    for (let attempt = 0; attempt < 30; attempt++) {
      const deck = E.shuffle(E.makeDeck());
      const hands = [[], [], [], []];
      const sizes = [8 + Math.floor(Math.random() * 10), 4 + Math.floor(Math.random() * 8), 6 + Math.floor(Math.random() * 10), 4 + Math.floor(Math.random() * 8)];
      let di = 0;
      for (let s = 0; s < 4; s++) for (let i = 0; i < sizes[s]; i++) hands[s].push(deck[di++]);
      hands.forEach(h => E.sortHand(h, level));
      // 构造轻量局面(只用于本题)
      const g = {
        level, hands, trick: null, turn: 0, userSeat: 0, difficulty: 'hard',
        playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
        teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
      };
      const moves = E.genMoves(hands[0], level, null);
      if (moves.length < 5) continue;
      const analyzed = moves.map(m => A.analyzeMove(g, 0, m)).sort((a, b) => b.score - a.score);
      if (analyzed[0].score - (analyzed[3] ? analyzed[3].score : 0) < 30) continue; // 没有明显最佳, 换题
      const picks = [analyzed[0]];
      for (const a of analyzed.slice(1)) { if (picks.length >= 4) break; picks.push(a); }
      while (picks.length < 4 && analyzed.length > picks.length) picks.push(analyzed[picks.length]);
      const shuffled = picks.slice().sort(() => Math.random() - 0.5);
      return {
        title: '出牌习题 · 打' + E.levelStr(level),
        situation: `你是南家(与北家一队), 打${E.levelStr(level)}, 现在由你领出。\n` +
          `你的手牌: ${E.cnames(E.sortHand(hands[0].slice(), level), level)}\n` +
          `下家剩${hands[1].length}张, 对家剩${hands[2].length}张, 上家剩${hands[3].length}张。`,
        hands,
        options: shuffled.map(a => ({ label: E.comboDesc(a.move, level) + ' ' + E.cnames(a.move.cards, level), move: a.move })),
        answer: shuffled.indexOf(picks[0]),
        explain: '【AI首选】' + (picks[0].notes.map(n => n.t).join('; ') || '综合手数与控牌最优') +
          '\n其余选项的主要问题: ' + picks.slice(1).map(a => a.notes.find(n => ['denyFeed', 'risk', 'waste', 'bombUse', 'break'].includes(n.k))?.t).filter(Boolean).slice(0, 2).join('; ')
      };
    }
    return null;
  }

  /* ---------------- 3. 精讲残局库 ---------------- */
  /* 每题: 固定手牌+局面, 固定选项与答案, 教一个战术概念 */
  const DRILLS = [
    {
      title: '残局1 · 顶牌(保护对家的顺子)', level: 8,
      hands: [C('SQ SK SA H8'), C('S3 S4'), C('C3 C4 C5 C6 C7'), C('D5 D10')],
      turn: 0, trick: { type: 'single', value: 3, n: 1, cards: C('C3') }, trickSeat: 2,
      question: '对家(北)领出单3, 他手里是 334455667 这类牌型潜力。下家(东)和你之后的上家(西)都还没表态。你手里 SQ SK SA + 级牌红桃8。该出什么?',
      options: [
        { label: '不要(让对家继续)', cards: null },
        { label: '出 SQ', cards: C('SQ') },
        { label: '出 SA', cards: C('SA') },
        { label: '出 级牌红桃8', cards: C('H8') }
      ],
      answer: 1,
      explain: '对家一手顺子潜力很大, 但单3太小, 下家/上家随便一张5、6就能白接走。用Q"顶"一手: 中等偏大、对手要用A/K才压得住, 给对家顺子铺路。出A浪费(A能顶更多场合), 红桃级牌是百搭要留着配牌, 不要则把风险全留给同伴 —— 这就是"顶牌"与"让牌"的分界: 同伴牌小且后面还有对手→顶; 同伴牌已够大→让。'
    },
    {
      title: '残局2 · 喂牌(送对家走头游)', level: 8,
      hands: [C('S3 S4 S9 SK SA'), C('H5 H9 H10 H7'), C('C10 CJ'), C('D5 D9 DK')],
      turn: 0, trick: null, trickSeat: 0,
      question: '你是南家, 对家(北)只剩2张(10J一把好牌), 两个对手都还有4张上下。你领出, 怎么出?',
      options: [
        { label: '出单张 S3', cards: C('S3') },
        { label: '出单张 SA', cards: C('SA') },
        { label: '出 SK', cards: C('SK') },
        { label: '出单张 S9', cards: C('S9') }
      ],
      answer: 0,
      explain: '对家报双张(10J), 大概率一把走完 → 你要出"他接得最舒服"的小单张: 他出10或J直接头游! 出SA/SK看似控场, 实则逼对家用10/J来接你的大牌, 万一接不上牌权就断了。记住口诀: 对家报牌喂小牌, 对手报牌顶大牌。'
    },
    {
      title: '残局3 · 拆炸时机(防对手报单)', level: 6,
      hands: [C('S5 H5 D5 C5 S3 SK HK'), C('H9 H10'), C('C9 C10'), C('D9 D10 DA')],
      turn: 0, trick: { type: 'pair', value: 10, n: 2, cards: C('D9 D10') }, trickSeat: 3,
      question: '上家(西)出了对10, 下家(东)只剩2张(910)! 你手里四个5 + 单3 + 对K。出什么?',
      options: [
        { label: '不要', cards: null },
        { label: '四个5炸弹炸上去', cards: C('S5 H5 D5 C5') },
        { label: '出对K', cards: C('SK HK') }
      ],
      answer: 1,
      explain: '下家只剩2张, 若让他这一轮轻松接牌, 他下一手就可能走完。炸弹上桌夺权, 然后领出单3或对K继续控场 —— 对手没牌权就出不了牌。炸弹不是只留给自己走牌用的: 拦截对手报单、为对家创造头游, 都是炸弹的高价值用法。反例: 对手都不缺牌时, 拿炸去压一个对10就是严重浪费。'
    },
    {
      title: '残局4 · 收头游(先算清最后一手)', level: 8,
      hands: [C('S6 S7 S8 S9 S10 SK SA S2'), C('H5 H9'), C('C5 C9'), C('D5 D9 DK')],
      turn: 0, trick: null, trickSeat: 0,
      question: '你8张: 678910顺子潜力 + K A 2三张大牌。三对手牌都不多了。你领出, 哪条路线对?',
      options: [
        { label: '先出顺子678910, 剩K/A/2逐张走', cards: C('S6 S7 S8 S9 S10') },
        { label: '先出A(最大单张抢一轮), 再走顺子', cards: C('SA') },
        { label: '先出单张2(级牌, 单张里最大)', cards: C('S2') },
        { label: '先出K', cards: C('SK') }
      ],
      answer: 0,
      explain: '先数手数: 顺子1手 + K/A/2三张单 = 4手。关键在"最后一手能不能自己走掉": 先走顺子(最容易被压的一手), 剩下K、A、2张张是大牌, 每张都能自己开路。反过来先出A/2, 就把最容易被压的顺子留到最后, 一旦被压就全盘卡死。口诀: 难走的手先走, 硬牌留后路。'
    },
    {
      title: '残局5 · 防双下(宁失头游不双下)', level: 9,
      hands: [C('S3 S4 S10'), C('H5 H9 HK'), C('C5 C9 CK'), C('D5 D9 DK DA')],
      turn: 0, trick: null, trickSeat: 0,
      question: '坏局面: 对家(北)也被压得只剩3张小牌, 下家3张、上家4张且都比你的大。你预判自己最多二游。领出什么能把损失锁在"单下"?',
      options: [
        { label: '出单3, 尽量少留牌权给对手', cards: C('S3') },
        { label: '出单10(最大的单张)', cards: C('S10') },
        { label: '出单4', cards: C('S4') },
        { label: '随便出, 反正要输', cards: null }
      ],
      answer: 0,
      explain: '双下 = 输3级; 单下 = 输1~2级, 差别巨大。明知抢不到头游时, 目标变成"保证队友不是末游": 出最小单张, 用最小代价换一轮牌权, 让对家有机会走掉一张。出10看似拼一把, 实则把"自己多走一张"建立在大牌权上, 但两对手牌更大, 你抢不到头游, 队友反而少一轮机会。掼蛋的胜负单位是"级", 防双下的价值经常高于博头游。'
    },
    {
      title: '残局6 · 同花顺 vs 炸弹(记牌定生死)', level: 8,
      hands: [C('H3 H4 H5 H6 H7 S2'), C('H9'), C('C9 C10'), C('D9 D10 DJ')],
      turn: 0, trick: { type: 'bomb', n: 5, value: 9, cards: C('S9x2 H9x2 D9') }, trickSeat: 3,
      question: '上家甩出5张9的炸弹! 你手里红桃34567同花顺 + 单2。(同点数8张里已现5张, 未现只剩3张, 对手不可能再有5张9炸) 出什么?',
      options: [
        { label: '同花顺压上(同花顺>5张炸弹)', cards: C('H3 H4 H5 H6 H7') },
        { label: '不要, 省着同花顺', cards: null },
        { label: '出单2', cards: C('S2') },
        { label: '出红桃7', cards: C('H7') }
      ],
      answer: 0,
      explain: '规则: 同花顺压≤5张炸弹, 6张以上炸弹才压同花顺。对手用了5张9炸, 你同花顺接住 → 这一圈你是最大, 接着领出单2, 大概率再收一圈。如果"省"着, 上家收圈后对手牌权连续, 你的2可能都出不去。记忆要点: 未现同点数≥4就要防炸, 同花顺是专门的"拆弹部队", 别舍不得用。'
    }
  ];

  /* 静态局面求解(残局校验用) */
  function solveDrill(drill) {
    const g = {
      level: drill.level, hands: drill.hands, trick: drill.trick ? { combo: drill.trick, seat: drill.trickSeat } : null,
      turn: drill.turn, userSeat: 0, difficulty: 'hard',
      playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
      teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
    };
    const moves = E.genMoves(drill.hands[drill.turn], drill.level, drill.trick);
    return moves.map(m => A.analyzeMove(g, drill.turn, m)).sort((a, b) => b.score - a.score);
  }

  GD.trainer = { makeMemoryQuiz, makePlayDrill, DRILLS, solveDrill, C };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD;
})(typeof window !== 'undefined' ? window : globalThis);
