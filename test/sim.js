'use strict';

// 全机器人对局模拟：验证引擎在大量随机对局下必有终局、无死锁、无非法状态。
// 同步跑（不走房间定时器），默认 50 局 × 两种模式 × 不同人数。

const { Game } = require('../server/game/engine');
const bots = require('../server/game/bots');

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

function playOne(n, devilMode, seed) {
  const rng = mulberry32(seed);
  const g = new Game({
    players: Array.from({ length: n }, (_, i) => ({ name: `Bot${i}`, isBot: true })),
    devilMode,
    rng,
    rngInt: (x) => Math.floor(rng() * x),
  });
  g.startGame();

  let turns = 0;
  const MAX_TURNS = 10000; // 防死锁护栏
  while (g.phase === 'round') {
    if (++turns > MAX_TURNS) {
      throw new Error(`疑似死锁：seed=${seed} n=${n} devil=${devilMode} 超过 ${MAX_TURNS} 拍未终局`);
    }
    // 不变量检查
    const active = g.activeSeats();
    assertInvariant(g, active);

    const view = g.sanitizedFor(g.turnSeat);
    const action = bots.decide(view);
    if (!action) throw new Error(`机器人无动作：seed=${seed} seat=${g.turnSeat}`);
    const res =
      action.type === 'call' ? g.callLiar(g.turnSeat) : g.playCards(g.turnSeat, action.cardIds);
    if (res.type === 'challenge' && !res.gameOver) {
      // 引擎已在内部开新局，不需要额外处理
    }
  }
  return { winner: g.winner, rounds: g.roundNo, turns };
}

function assertInvariant(g, active) {
  // 行动者必须存活且有牌
  const p = g.players[g.turnSeat];
  if (!p || !p.alive) throw new Error(`行动者已死亡 seed 侧非法 seat=${g.turnSeat}`);
  if (g.hands[g.turnSeat].length === 0) throw new Error('行动者没有手牌');
  // mustCall 与活跃人数一致
  if (g.pile.length > 0 && active.length === 1) {
    if (!g.mustCall) throw new Error('只剩一人有牌却未标记 mustCall');
  }
  // 手牌数 0..5
  for (const h of g.hands) {
    if (h.length < 0 || h.length > 5) throw new Error('手牌数非法');
  }
}

const N_GAMES = parseInt(process.env.SIM_GAMES || '50', 10);

let wins = new Map();
let totalRounds = 0;
let games = 0;
for (let seed = 1; seed <= N_GAMES; seed++) {
  for (const devilMode of [false, true]) {
    for (const n of [2, 3, 4]) {
      const r = playOne(n, devilMode, seed * 1000 + n * 7 + (devilMode ? 3 : 0));
      if (r.winner === null) {
        // 平局（全桌覆灭）也计入
      } else {
        wins.set(r.winner, (wins.get(r.winner) || 0) + 1);
      }
      totalRounds += r.rounds;
      games++;
    }
  }
}

console.log(`✅ 模拟完成：${games} 局全部正常终局（无死锁）`);
console.log(`   总局数 ${games}，累计 ${totalRounds} 个小局，平均每局 ${(totalRounds / games).toFixed(1)} 小局`);
const devils = [...wins.entries()].map(([seat, c]) => `座位${seat}胜 ${c} 次`).join('，');
console.log(`   ${devils}`);
