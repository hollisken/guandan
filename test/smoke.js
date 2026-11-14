/* 引擎冒烟测试: node test/smoke.js */
require('../js/engine.js');
require('../js/ai.js');
const GD = globalThis.GD;
const E = GD.engine;
const A = GD.ai;
let pass = 0, fail = 0;
function T(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } }
function C(str) { // 简易构造牌: "SA S2 H5 H5x2 X X x x"; X=大王 x=小王, x2=两张
  const out = [];
  for (const tok of str.split(/\s+/)) {
    if (!tok) continue;
    let s, r, rep = 1, m;
    if ((m = tok.match(/^([Xx])(x(\d))?$/))) {
      s = 'J'; r = m[1] === 'X' ? 16 : 15; rep = m[3] ? +m[3] : 1;
    } else {
      m = tok.match(/^([SHDC])(.+?)(x(\d))?$/);
      s = m[1]; const rr = m[2];
      r = rr === 'A' ? 14 : rr === 'K' ? 13 : rr === 'Q' ? 12 : rr === 'J' ? 11 : parseInt(rr);
      rep = m[4] ? +m[4] : 1;
    }
    for (let i = 0; i < rep; i++) out.push({ id: 't' + Math.random(), rank: r, suit: s });
  }
  return out;
}
const L = 8; // 默认打8测试

// --- 单张大小 ---
T('大王>小王', E.ov({ rank: 16, suit: 'J' }, L) > E.ov({ rank: 15, suit: 'J' }, L));
T('小王>级牌', E.ov({ rank: 15, suit: 'J' }, L) > E.ov({ rank: 8, suit: 'S' }, L));
T('级牌>A', E.ov({ rank: 8, suit: 'S' }, L) > E.ov({ rank: 14, suit: 'S' }, L));
T('级牌=8时其他2最小', E.ov({ rank: 2, suit: 'S' }, L) === 2);

// --- 顺子 ---
T('A2345 顺子', !!E.interpret(C('H14 S2 S3 S4 S5'), L, null));
T('23456 顺子', !!E.interpret(C('S2 S3 S4 S5 S6'), L, null));
T('10JQKA 顺子', !!E.interpret(C('S10 S11 S12 S13 S14'), L, null));
T('JQKA2 不合法', !E.interpret(C('S11 S12 S13 S14 S2'), L, null));
const s1 = E.interpret(C('H14 S2 S3 S4 S5'), L, null);
T('A2345 value=5', s1.value === 5);
const s2 = E.interpret(C('S10 S11 S12 S13 S14'), L, null);
T('10JQKA value=14', s2.value === 14);
T('910JQK > 10JQKA? 否', !E.beats(E.interpret(C('S9 S10 S11 S12 S13'), L, null), s2));

// --- 三连对/钢板(依规则: 必须且只能三连对/二连三) ---
T('AA2233 连对', !!E.interpret(C('S14 S14 S2 S2 S3 S3'), L, null));
T('334455 三连对', !!E.interpret(C('S3 S3 S4 S4 S5 S5'), L, null));
T('AA2233 < 334455', E.beats(E.interpret(C('S3 S3 S4 S4 S5 S5'), L, null), E.interpret(C('S14 S14 S2 S2 S3 S3'), L, null)));
T('四连对 33445566 非法', !E.interpret(C('S3 S3 H3 S4 H4 S5 H5 S6 H6'), L, null));
T('五连对非法', !E.interpret(C('S3 S3 H3 D3 S4 H4 D4 S5 H5 D5'), L, null));
T('二连对 3344 非法', !E.interpret(C('S3 S3 S4 H4'), L, null));
T('钢板 二连三 333444', !!E.interpret(C('S3 H3 D3 S4 H4 D4'), L, null));
T('AAA222 钢板(A作1)', !!E.interpret(C('S14 S14 S14 S2 S2 S2'), L, null));
T('三连三 JJJQQQKKK 非法', !E.interpret(C('S11 H11 D11 S12 H12 D12 S13 H13 D13'), L, null));

// --- 炸弹/同花顺/天王 ---
T('4张炸弹', E.interpret(C('S5 H5 D5 C5'), L, null).type === 'bomb');
T('10张炸弹(百搭配)', !!E.interpret(C('H8 H8 S5x8'), L, null));
T('同花顺>5张炸弹', E.beats(E.interpret(C('H3 H4 H5 H6 H7'), L, null), E.interpret(C('S5 H5 D5 C5 H5x1'), L, null)));
T('6张炸弹>同花顺', E.beats(E.interpret(C('S5 H5 D5 C5 H5 D5'), L, null), E.interpret(C('H3 H4 H5 H6 H7'), L, null)));
T('4炸不压同花顺', !E.beats(E.interpret(C('S5 H5 D5 C5'), L, null), E.interpret(C('H3 H4 H5 H6 H7'), L, null)));
T('四王最大', E.interpret(C('X X x x'), L, null).type === 'rocket');
const rocket = E.interpret(C('x x X X'), L, null);
T('四王压8张炸', rocket ? E.beats(rocket, E.interpret(C('S5 H5 D5 C5 H5 D5 S5 C5'), L, null)) : false);

// --- 逢人配 ---
T('百搭单出=级牌15', E.interpret(C('H8'), L, null).value === 15);
T('百搭配顺子 56789', !!E.interpret(C('H8 S5 S6 S7 S9'), L, null));
T('百搭配炸弹', E.interpret(C('H8 S9 H9 D9'), L, null).type === 'bomb');
T('百搭+两真级牌=对级牌', E.interpret(C('H8 S8'), L, null).value === 15);
T('三带二多解取强(三8带对3)', E.interpret(C('H8 S8 D8 S3 C3'), L, null).value === 15);
const t3 = E.interpret(C('H3 S3 D3 S8 C8'), 3, null); // 打3: H3是百搭
T('打3时三3带对8', t3 && t3.value === 15);

// --- AI 过牌基准(国家规则: 能压也可不要) ---
{
  // 对手领出三连对; 我手里4张5的炸+两张散单(炸完仍多手) → AI应选择"不要"
  const g2 = {
    level: L, userSeat: 0, difficulty: 'hard', turn: 0,
    hands: [C('S5 H5 D5 C5 S3 S4'), C('S6 H6 S7 H7 S8 H8'), C('S9 H9 D9'), C('S10 H10 D10')],
    trick: { combo: E.interpret(C('S6 H6 S7 H7 S8 H8'), L, null), seat: 1 },
    playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
    teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
  };
  const mv = A.aiMove(g2, 0);
  T('只剩炸弹可压时AI选择不要: ' + (mv ? mv.move.type : 'null'), mv === null);
  // 同伴在管一张小单, 我有炸和大单 → AI不炸同伴也不过度顶牌, 选择不要
  const g3 = {
    level: L, userSeat: 0, difficulty: 'hard', turn: 0,
    hands: [C('S5 H5 D5 C5 SK'), C('S6'), C('S7 H7 D7 S8 H8 D8'), C('S9 H9 D9')],
    trick: { combo: E.interpret(C('S7'), L, null), seat: 2 },
    playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
    teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
  };
  const mv3 = A.aiMove(g3, 0);
  T('同伴管牌时AI不炸: ' + (mv3 ? mv3.move.type : 'pass'), mv3 === null || mv3.move.type !== 'bomb');
  // 出牌顺序: 开局领出应从小单张走起, 不出K/A
  const g4 = {
    level: L, userSeat: 0, difficulty: 'hard', turn: 0, trick: null,
    hands: [C('S3 S9 SK SA S7 H7 D7'), C('S6 H6 D6 S9 H9 D9'), C('S8 H8 D8 SQ HQ DQ'), C('S10 H10 D10 SJ')],
    playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
    teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
  };
  const mv4 = A.aiMove(g4, 0, 'hard');
  T('开局领出最小单张(不出大单): ' + (mv4 ? mv4.move.type + mv4.move.value : 'pass'),
    mv4 && mv4.move.type === 'single' && mv4.move.value <= 9);
  // 拆牌抢权: 对家报单(剩1张), 我手里对3+大单 → 应拆对3喂小单张
  const g5 = {
    level: L, userSeat: 0, difficulty: 'hard', turn: 0, trick: null,
    hands: [C('S3 H3 SA S8'), C('S7 H7 D7 S9 H9 D9'), C('S6'), C('S10 H10 D10 SJ')],
    playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
    teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
  };
  const mv5 = A.aiMove(g5, 0, 'hard');
  T('对家报单时拆对3喂小单: ' + (mv5 ? mv5.move.type + mv5.move.value : 'pass'),
    mv5 && mv5.move.type === 'single' && mv5.move.value === 3);
  // 顶牌到位: 对手领单3, 同伴已不要, 我 = 对K + 单A + 低张 → 必须顶(不能放), 且顶大牌
  const g6 = {
    level: L, userSeat: 0, difficulty: 'hard', turn: 0,
    hands: [C('SK HK SA S4'), C('S3'), C('S6 H6 D6 S8 H8 D8'), C('S10 H10 D10 SJ')],
    trick: { combo: E.interpret(C('S3'), L, null), seat: 1 },
    playLog: [{ seat: 2, pass: true, handsLeft: [4, 1, 6, 4] }],
    playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
    teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
  };
  const mv6 = A.aiMove(g6, 0, 'hard');
  T('对手领小单同伴不要时必须顶大牌: ' + (mv6 ? mv6.move.type + mv6.move.value : 'pass'),
    mv6 && mv6.move.type === 'single' && mv6.move.value >= 13);
  // 逢人配保护: 手里百搭配不进任何组合时, 开局不能领出百搭单张
  const g7 = {
    level: 2, userSeat: 0, difficulty: 'hard', turn: 0, trick: null,
    hands: [C('H2 S3 H3 D3 S10 H10 D10'), C('S6 H6 D6 S9 H9 D9'), C('SQ HQ DQ SK'), C('S5 H5 D5 SJ')],
    playLog: [], playedAll: [], playedBy: [[], [], [], []], passedBy: [[], [], [], []],
    teamOf: s => s % 2, partnerOf: s => (s + 2) % 4
  };
  const mv7 = A.aiMove(g7, 0, 'hard');
  const wildId = g7.hands[0].find(c => E.isWild(c, 2)).id;
  T('开局不领出逢人配: ' + (mv7 ? mv7.move.type + ' 含百搭=' + mv7.move.cards.some(c => c.id === wildId) : 'pass'),
    mv7 && !mv7.move.cards.some(c => c.id === wildId));
}

// --- 对局 ---
function simMatch(maxHands) {
  const g = new E.Game({ startLevel: 2 });
  let hands = 0;
  while (!g.matchOver && hands < (maxHands || 120)) {
    hands++;
    let moves = 0;
    while (moves < 3000) {
      moves++;
      if (g.phase === 'tribute') { // 用户还贡: 自动还最小≤10单张
        const cands = g.hands[g.userSeat].filter(c => c.rank <= 10).sort((a, b) => a.rank - b.rank);
        if (!cands.length) return 'tribute-nocand';
        g.userReturnTribute(cands[0]);
        continue;
      }
      if (g.phase !== 'play') break;
      const seat = g.turn;
      const movesL = E.genMoves(g.hands[seat], g.level, g.trick ? g.trick.combo : null);
      // 简单策略: 能一手出完就出; 否则随机(领出出最小单/对, 跟牌能压就压)
      if (!g.trick) {
        if (movesL.length === 0) return 'nolead';
        // 领出: 选牌数最多的一手(加快)
        movesL.sort((a, b) => b.cards.length - a.cards.length || Math.random() - 0.5);
        g.play(seat, movesL[0].cards);
      } else {
        if (movesL.length && Math.random() < 0.6) {
          movesL.sort((a, b) => E.strength(a) - E.strength(b));
          g.play(seat, movesL[0].cards);
        } else g.play(seat, null);
      }
    }
    if (g.phase !== 'handEnd') return 'stuck:' + g.phase;
    // 校验: 出牌+手牌=108
    const total = g.playedAll.length + g.hands.reduce((a, h) => a + h.length, 0);
    if (total !== 108) return 'cardloss:' + total;
    if (g.outOrder.length < 2) return 'outorder';
    const res = g.lastResult;
    if (![3, 2, 1].includes(res.inc)) return 'inc:' + res.inc;
    if (g.matchOver) {
      if (g.level !== 14 || !res.passedA) return 'matchend-wrong';
      break;
    }
    g.nextHand();
  }
  return g.matchOver ? 'ok' : 'noend';
}
const r1 = simMatch(120);
T('完整比赛模拟: ' + r1, r1 === 'ok');
// 多次随机模拟
let allOk = true;
for (let i = 0; i < 5; i++) { const r = simMatch(120); if (r !== 'ok') { allOk = false; console.log('sim fail:', r); } }
T('5次随机比赛模拟', allOk);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
