'use strict';

// 机器人 AI：只读引擎消毒快照，返回动作。人类玩家超时的托底动作也复用这里。
// 启发式设计见 docs/ARCHITECTURE.md 第 6 节。

const rand = Math.random;

function truthsInHand(view) {
  return view.hand.filter((c) => c.rank === view.tableCard || c.rank === 'Joker' || (c.devil && c.rank === view.tableCard));
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * @param {object} view game.sanitizedFor(botSeat)
 * @returns {{type:'play', cardIds:string[]}|{type:'call'}|null} null 表示无合法动作
 */
function decide(view) {
  if (!view.yourTurn) return null;

  const canPlay = view.canPlay;
  const canCall = view.canCall;

  // 必须质疑（只剩自己有手牌）
  if (view.mustCall) return canCall ? { type: 'call' } : null;
  // 第一手：只能出牌
  if (!canCall) return canPlay ? decidePlay(view) : null;

  // 出牌 / 质疑 二选一：先估算怀疑度
  const unseenTruths = 8 - truthsInHand(view).length; // 场上其余玩家手里+牌堆可能存在的真牌上限
  const claimed = view.pile.total;
  const suspicion = claimed > 0 ? Math.max(0, claimed - unseenTruths) / claimed : 0;

  let callProb = 0.35 + 0.5 * suspicion;
  if (view.lastPlay && view.lastPlay.count === 3) callProb += 0.15;
  const me = view.players[view.you];
  if (me.punishments >= 2) callProb += 0.2; // 再受罚近必死，索性赌质疑
  if (truthsInHand(view).length <= 1 && view.hand.length >= 3) callProb += 0.15; // 手牌烂，盼重发
  if (view.mode === 'devil' && view.lastPlay && view.lastPlay.count === 1) callProb -= 0.15; // 怕恶魔牌
  callProb = clamp(callProb, 0.02, 0.9);

  // 数学上牌堆必有假牌 → 必质疑
  if (claimed > unseenTruths) return { type: 'call' };

  if (rand() < callProb) return { type: 'call' };
  return decidePlay(view);
}

function decidePlay(view) {
  const hand = view.hand;
  if (hand.length === 0) return null;

  // 恶魔标记牌绝不与其他牌混出
  const playable = hand.filter((c) => !c.devil);
  const truths = playable.filter((c) => c.rank === view.tableCard || c.rank === 'Joker');
  const fakes = playable.filter((c) => c.rank !== view.tableCard && c.rank !== 'Joker');

  // 手里有同点恶魔牌：把它当真牌单独打；受罚多时更倾向打出保命
  const devilMatch = hand.find((c) => c.devil && c.rank === view.tableCard);
  if (devilMatch) {
    const me = view.players[view.you];
    const wantDevil = me.punishments >= 1 ? 0.5 : 0.25;
    if (rand() < wantDevil) return { type: 'play', cardIds: [devilMatch.id] };
  }

  // 手里只剩恶魔牌：只能单出
  if (playable.length === 0) {
    return { type: 'play', cardIds: [hand[0].id] };
  }

  if (truths.length >= 2 && rand() < 0.65) {
    // 出真牌：1 张为主，全真手牌倾向多出快速清牌
    const n = truths.length === playable.length ? (rand() < 0.6 ? Math.min(3, truths.length) : 2) : 1;
    return { type: 'play', cardIds: truths.slice(0, n).map((c) => c.id) };
  }

  if (truths.length === playable.length) {
    // 剩余可出的全是真牌
    const n = rand() < 0.5 ? Math.min(3, truths.length) : 1;
    return { type: 'play', cardIds: truths.slice(0, n).map((c) => c.id) };
  }

  // 假牌局面：尽量少出降低风险
  const bluff = fakes.length > 0 ? fakes : playable;
  const n = rand() < 0.15 && bluff.length >= 2 ? 2 : 1;
  return { type: 'play', cardIds: bluff.slice(0, n).map((c) => c.id) };
}

module.exports = { decide };
