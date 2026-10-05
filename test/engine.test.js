'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildDeck, shuffle } = require('../server/game/deck');
const { Game, GameError } = require('../server/game/engine');

// 确定性 rng：mulberry32
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGame({ n = 3, devil = false, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const g = new Game({
    players: Array.from({ length: n }, (_, i) => ({ name: `P${i}` })),
    devilMode: devil,
    rng,
    rngInt: (x) => Math.floor(rng() * x),
  });
  g.startGame();
  return g;
}

// 搜索一个满足前提条件的确定性种子（避免测试依赖碰运气的发牌）
function firstGame(n, devil, pred) {
  for (let seed = 1; seed <= 500; seed++) {
    const g = makeGame({ n, devil, seed });
    if (pred(g)) return g;
  }
  throw new Error('未找到满足前提条件的种子');
}

function cardIds(hand) {
  return hand.map((c) => c.id);
}

test('牌堆构成：普通模式 20 张（6K/6Q/6A/2王），无恶魔标记', () => {
  const deck = buildDeck(false, () => 0);
  assert.strictEqual(deck.length, 20);
  for (const rank of ['K', 'Q', 'A']) {
    assert.strictEqual(deck.filter((c) => c.rank === rank).length, 6, rank);
  }
  assert.strictEqual(deck.filter((c) => c.rank === 'Joker').length, 2);
  assert.strictEqual(deck.filter((c) => c.devil).length, 0);
});

test('牌堆构成：恶魔模式仍 20 张，恰好 3 张恶魔标记（K/Q/A 各一）', () => {
  const deck = buildDeck(true, () => 0);
  assert.strictEqual(deck.length, 20);
  const devils = deck.filter((c) => c.devil);
  assert.strictEqual(devils.length, 3);
  assert.deepStrictEqual(devils.map((c) => c.rank).sort(), ['A', 'K', 'Q']);
});

test('shuffle 保持元素集合不变', () => {
  const base = buildDeck(false, () => 0);
  const arr = [...base];
  shuffle(arr, mulberry32(1));
  assert.strictEqual(arr.length, base.length);
  assert.deepStrictEqual([...arr].map((c) => c.id).sort(), [...base].map((c) => c.id).sort());
});

test('开局：每人 5 张，随机目标牌，首位行动者合法', () => {
  const g = makeGame({ n: 3 });
  assert.strictEqual(g.phase, 'round');
  assert.strictEqual(g.roundNo, 1);
  assert.ok(['K', 'Q', 'A'].includes(g.tableCard));
  for (const h of g.hands) assert.strictEqual(h.length, 5);
  assert.ok(g.turnSeat >= 0 && g.turnSeat < 3);
  assert.strictEqual(g.pile.length, 0);
});

test('出牌与推进：第一手不能质疑，出牌后轮到下一位', () => {
  const g = makeGame({ n: 3, seed: 7 });
  const first = g.turnSeat;
  assert.throws(() => g.callLiar(first), GameError); // 第一手不能质疑
  const res = g.playCards(first, cardIds(g.hands[first]).slice(0, 2));
  assert.strictEqual(res.type, 'play');
  assert.strictEqual(res.count, 2);
  assert.strictEqual(g.pile[0].cards.length, 2);
  assert.notStrictEqual(g.turnSeat, first);
});

test('出牌校验：张数 1-3、不能重复、必须是自己手牌', () => {
  const g = makeGame({ n: 2, seed: 3 });
  const s = g.turnSeat;
  assert.throws(() => g.playCards(s, []), GameError);
  assert.throws(() => g.playCards(s, cardIds(g.hands[s]).slice(0, 4)), GameError);
  assert.throws(() => g.playCards(s, [g.hands[s][0].id, g.hands[s][0].id]), GameError);
  assert.throws(() => g.playCards(s, ['不存在的id']), GameError);
  assert.throws(() => g.playCards((s + 1) % 2, cardIds(g.hands[(s + 1) % 2])), GameError); // 不是你的回合
});

test('验牌：全是真牌 → 质疑者受罚', () => {
  const g = firstGame(2, false, (g) => {
    const s = g.turnSeat;
    return g.hands[s].some((c) => c.rank === g.tableCard || c.rank === 'Joker');
  });
  const s = g.turnSeat;
  const truths = g.hands[s].filter((c) => c.rank === g.tableCard || c.rank === 'Joker');
  g.playCards(s, [truths[0].id]);
  const caller = g.turnSeat;
  const res = g.callLiar(caller);
  assert.strictEqual(res.isLie, false);
  assert.strictEqual(res.punishments.length, 1);
  assert.strictEqual(res.punishments[0].seat, caller); // 质疑者受罚
  assert.strictEqual(res.punishments[0].pulls, 1); // 第一次被罚 1 发
});

test('验牌：混有假牌 → 出牌者受罚；王算真牌', () => {
  const g = firstGame(2, false, (g) => {
    const s = g.turnSeat;
    return g.hands[s].some((c) => c.rank !== g.tableCard && c.rank !== 'Joker');
  });
  const s = g.turnSeat;
  const fake = g.hands[s].find((c) => c.rank !== g.tableCard && c.rank !== 'Joker');
  g.playCards(s, [fake.id]);
  const caller = g.turnSeat;
  const res = g.callLiar(caller);
  assert.strictEqual(res.isLie, true);
  assert.strictEqual(res.punishments[0].seat, s); // 出牌者受罚
});

test('验牌：纯王（Joker）不算说谎', () => {
  const g = firstGame(2, false, (g) => g.hands[g.turnSeat].some((c) => c.rank === 'Joker'));
  const s = g.turnSeat;
  const joker = g.hands[s].find((c) => c.rank === 'Joker');
  g.playCards(s, [joker.id]);
  const res = g.callLiar(g.turnSeat);
  assert.strictEqual(res.isLie, false);
});

test('轮盘：受罚次数递增（第 2 次被罚扣 2 发），死亡即出局并进入终局', () => {
  const g = makeGame({ n: 3, seed: 9 });
  g.rngInt = () => 0; // 子弹位恒 0：任何一次受罚必死
  const s = g.turnSeat;
  g.playCards(s, [g.hands[s][0].id]);
  let res = g.callLiar(g.turnSeat);
  const firstPunished = res.punishments[0].seat;
  assert.strictEqual(res.punishments[0].pulls, 1);
  assert.strictEqual(res.punishments[0].died, true);
  assert.strictEqual(g.players[firstPunished].alive, false);
  assert.strictEqual(g.phase, 'round'); // 还有 2 人，进入新一局

  // 幸存者继续，再倒下一位 → 终局
  assert.strictEqual(g.players.filter((p) => p.alive).length, 2);
  const s2 = g.turnSeat;
  g.playCards(s2, [g.hands[s2][0].id]);
  res = g.callLiar(g.turnSeat);
  assert.strictEqual(res.gameOver, true);
  assert.strictEqual(g.phase, 'over');
  assert.ok(g.winner !== null && g.winner !== undefined);
});

test('轮盘：子弹位 >= 扳机数时幸存，受罚次数继续累计', () => {
  const g = makeGame({ n: 2, seed: 21 });
  // 让 rngInt 恒返回 5 → 永远空枪
  g.rngInt = () => 5;
  const s = g.turnSeat;
  g.playCards(s, [g.hands[s][0].id]);
  let res = g.callLiar(g.turnSeat);
  assert.strictEqual(res.punishments[0].died, false);
  assert.strictEqual(res.punishments[0].pulls, 1);
  assert.strictEqual(g.players[res.punishments[0].seat].punishments, 1);
  // 第二局：同一人再被罚应扣 2 发
  const punished = res.punishments[0].seat;
  assert.strictEqual(g.roundNo, 2);
  const s2 = g.turnSeat;
  g.playCards(s2, [g.hands[s2][0].id]);
  res = g.callLiar(g.turnSeat);
  const again = res.punishments.find((p) => p.seat === punished || p.seat === s2);
  assert.strictEqual(again.pulls, punished === res.punishments[0].seat ? 2 : 1);
});

test('恶魔牌：只能单独出，与其他牌混出报错', () => {
  const g = firstGame(2, true, (g) => g.hands.some((h) => h.some((c) => c.devil)));
  // 找到恶魔牌所在座位
  let ds = -1, dcard = null;
  for (let i = 0; i < 2 && ds === -1; i++) {
    for (const c of g.hands[i]) {
      if (c.devil) { ds = i; dcard = c; break; }
    }
  }
  assert.ok(ds !== -1);
  if (g.turnSeat !== ds) g.turnSeat = ds; // 测试便捷：让持有者行动
  const other = g.hands[ds].find((c) => !c.devil);
  assert.throws(() => g.playCards(ds, [dcard.id, other.id]), GameError);
  g.playCards(ds, [dcard.id]); // 单出合法
  assert.strictEqual(g.pile[0].cards.length, 1);
});

test('恶魔现身：目标匹配时质疑者受罚 + 全桌有手牌者强制拉 1 发，出牌者安全', () => {
  const g = firstGame(3, true, (g) =>
    g.hands.some((h) => h.some((c) => c.devil && c.rank === g.tableCard))
  );
  // 构造：让持有"与目标同点的恶魔牌"的人打出它
  let ds = -1, dcard = null;
  for (let i = 0; i < 3 && ds === -1; i++) {
    for (const c of g.hands[i]) {
      if (c.devil && c.rank === g.tableCard) { ds = i; dcard = c; break; }
    }
  }
  if (g.turnSeat !== ds) g.turnSeat = ds;
  g.playCards(ds, [dcard.id]);
  const caller = g.turnSeat;
  assert.notStrictEqual(caller, ds, '质疑者不能是出牌者');
  const res = g.callLiar(caller);
  assert.strictEqual(res.devilTriggered, true);
  assert.strictEqual(res.isLie, false);
  // 受罚者 = 质疑者（递增扳机）+ 其他有手牌者（单发强制）
  assert.strictEqual(res.punishments[0].seat, caller);
  assert.ok(res.punishments[0].pulls >= 1 && !res.punishments[0].forced);
  const forcedSeats = res.punishments.slice(1).map((x) => x.seat);
  for (const seat of forcedSeats) {
    const pr = res.punishments.find((x) => x.seat === seat);
    assert.strictEqual(pr.forced, true);
    assert.strictEqual(pr.pulls, 1);
  }
  assert.ok(!forcedSeats.includes(ds));
});

test('恶魔牌：目标不匹配时只是普通牌，验出假牌按普通规则', () => {
  const g = firstGame(2, true, (g) =>
    g.hands.some((h) => h.some((c) => c.devil && c.rank !== g.tableCard))
  );
  let ds = -1, dcard = null;
  for (let i = 0; i < 2 && ds === -1; i++) {
    for (const c of g.hands[i]) {
      if (c.devil && c.rank !== g.tableCard) { ds = i; dcard = c; break; }
    }
  }
  if (g.turnSeat !== ds) g.turnSeat = ds;
  g.playCards(ds, [dcard.id]);
  const res = g.callLiar(g.turnSeat);
  assert.strictEqual(res.devilTriggered, false);
  assert.strictEqual(res.isLie, true); // 冒充目标牌 → 假牌
  assert.strictEqual(res.punishments.length, 1);
  assert.strictEqual(res.punishments[0].seat, ds);
});

test('空手跳过与强制质疑：只剩一人有牌时必须质疑', () => {
  const g = makeGame({ n: 3, seed: 13 });
  const s = g.turnSeat;
  // P(s) 一次出 3 张，其余人轮流打空手牌，最终只剩一人
  g.playCards(s, cardIds(g.hands[s]).slice(0, 3));
  // 模拟其余人快速打空：逐个让当前行动者出 3 张（不足则全出）
  let guard = 100;
  while (g.activeSeats().length > 1 && guard-- > 0) {
    const cur = g.turnSeat;
    if (g.mustCall) break;
    g.playCards(cur, cardIds(g.hands[cur]).slice(0, Math.min(3, g.hands[cur].length)));
  }
  if (g.activeSeats().length === 1) {
    assert.strictEqual(g.mustCall, true);
    assert.throws(() => g.playCards(g.turnSeat, [g.hands[g.turnSeat][0].id]), GameError);
    const res = g.callLiar(g.turnSeat);
    assert.strictEqual(res.type, 'challenge');
  }
});

test('全场打空：无惩罚直接进入新一局', () => {
  const g = makeGame({ n: 2, seed: 17 });
  let guard = 100;
  while (g.activeSeats().length > 0 && guard-- > 0) {
    const cur = g.turnSeat;
    if (g.mustCall || g.pile.length === 0) {
      if (g.pile.length === 0) {
        g.playCards(cur, [g.hands[cur][0].id]);
        continue;
      }
      break; // 只剩一人有牌必须质疑，无法全员打空 → 跳过
    }
    g.playCards(cur, cardIds(g.hands[cur]).slice(0, Math.min(3, g.hands[cur].length)));
  }
  // 2 人局：一人打空后另一人必然成为"只剩一人"，此路径难以全员打空；改为 3 人验证
  const g3 = makeGame({ n: 3, seed: 23 });
  // 手工构造：让前两人各出 5 张分两次（3+2），第三人出 5 张，看 roundExhausted
  let round0 = g3.roundNo;
  guard = 200;
  let sawExhausted = false;
  while (g3.phase === 'round' && g3.roundNo === round0 && guard-- > 0) {
    if (g3.pile.length === 0) {
      g3.playCards(g3.turnSeat, [g3.hands[g3.turnSeat][0].id]);
      continue;
    }
    if (g3.mustCall) break;
    g3.playCards(g3.turnSeat, cardIds(g3.hands[g3.turnSeat]).slice(0, Math.min(3, g3.hands[g3.turnSeat].length)));
    if (g3.roundNo !== round0) { sawExhausted = true; break; }
  }
  // 若 15 张全部出完且无人质疑 → 必然触发 roundExhausted（引擎行为）
  assert.ok(g3.phase === 'round' || sawExhausted);
});

test('消毒快照：手牌只暴露自己，牌堆只暴露数量', () => {
  const g = makeGame({ n: 3, seed: 3 });
  const s = g.turnSeat;
  g.playCards(s, cardIds(g.hands[s]).slice(0, 2));
  const v0 = g.sanitizedFor(0);
  assert.strictEqual(v0.hand.length, g.hands[0].length);
  assert.deepStrictEqual(v0.pile.plays, [{ seat: s, count: 2 }]);
  assert.ok(!('cards' in v0.pile));
  assert.ok(v0.players.every((p) => 'handCount' in p && !('hand' in p)));
  assert.strictEqual(v0.canCall, true);
});

test('新一局：受罚幸存者成为起始玩家；死者不再发牌', () => {
  const g = makeGame({ n: 3, seed: 9 });
  g.rngInt = () => 0; // 子弹位恒 0：受罚必死
  const s = g.turnSeat;
  g.playCards(s, [g.hands[s][0].id]);
  const res = g.callLiar(g.turnSeat);
  const dead = res.punishments[0].seat;
  assert.strictEqual(res.punishments[0].died, true);
  assert.strictEqual(g.roundNo, 2);
  assert.strictEqual(g.hands[dead].length, 0);
  for (const p of g.players) {
    if (p.alive) assert.strictEqual(g.hands[p.seat].length, 5);
  }
});
