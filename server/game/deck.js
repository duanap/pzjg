'use strict';

// 牌堆构建与洗牌。牌对象：{ id, rank: 'K'|'Q'|'A'|'Joker', suit: '♠'|'♥'|'🃏', devil: bool }

const RANKS = ['K', 'Q', 'A'];
const SUITS = ['♠', '♥'];

function buildDeck(devilMode, rngInt) {
  const randInt = rngInt || ((n) => Math.floor(Math.random() * n));
  const deck = [];
  let id = 0;
  for (const rank of RANKS) {
    for (let i = 0; i < 6; i++) {
      deck.push({ id: `c${id++}`, rank, suit: SUITS[i % 2], devil: false });
    }
  }
  deck.push({ id: `c${id++}`, rank: 'Joker', suit: '🃏', devil: false });
  deck.push({ id: `c${id++}`, rank: 'Joker', suit: '🃏', devil: false });

  if (devilMode) {
    // 每种点数随机标记一张为恶魔牌（共 3 张，不加牌）
    for (const rank of RANKS) {
      const candidates = deck.filter((c) => c.rank === rank && !c.devil);
      const picked = candidates[randInt(candidates.length)];
      picked.devil = true;
    }
  }
  return deck;
}

function shuffle(arr, rng) {
  const rand = rng || Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { RANKS, buildDeck, shuffle };
