'use strict';

// 纯游戏引擎：不含任何 IO / 定时器，随机数可注入，便于确定性单测。
// 规则见 docs/RULES.md。

const { RANKS, buildDeck, shuffle } = require('./deck');

class GameError extends Error {}

const HAND_SIZE = 5;
const TRUTHS_PER_DECK = 8; // 6 张目标牌 + 2 张王

class Game {
  /**
   * @param {object} opts
   * @param {Array<{name:string, isBot?:boolean}>} opts.players 座位顺序 = 数组顺序
   * @param {boolean} opts.devilMode 是否开启恶魔牌
   * @param {()=>number} [opts.rng]  [0,1) 随机数
   * @param {(n:number)=>number} [opts.rngInt] [0,n) 整数随机
   */
  constructor(opts) {
    if (!Array.isArray(opts.players) || opts.players.length < 2 || opts.players.length > 4) {
      throw new GameError('玩家人数必须在 2-4 之间');
    }
    this.devilMode = !!opts.devilMode;
    this.rng = opts.rng || Math.random;
    this.rngInt =
      opts.rngInt ||
      ((n) => {
        const x = this.rng();
        if (x < 0 || x >= 1) throw new GameError('rng 必须返回 [0,1)');
        return Math.floor(x * n);
      });

    this.players = opts.players.map((p, i) => ({
      seat: i,
      name: String(p.name || `玩家${i + 1}`).slice(0, 12),
      isBot: !!p.isBot,
      alive: true,
      punishments: 0, // 本场游戏累计受罚次数（决定下次扣几发）
      connected: p.connected !== false,
    }));

    this.phase = 'lobby'; // 'round' | 'over'
    this.roundNo = 0;
    this.tableCard = null;
    this.hands = this.players.map(() => []);
    this.pile = []; // [{seat, cards:[Card]}] 牌面仅服务端可见
    this.turnSeat = -1;
    this.mustCall = false; // 只剩一人有牌时必须质疑
    this.roundStarted = false; // 本局是否已有人出过牌（第一手不可质疑）
    this.winner = null;
    this.log = [];
  }

  // ---------- 生命周期 ----------

  startGame() {
    for (const p of this.players) {
      p.alive = true;
      p.punishments = 0;
    }
    this.winner = null;
    this.phase = 'round';
    this.startRound(this.rngInt(this.players.length));
  }

  startRound(firstSeat) {
    this.roundNo += 1;
    const deck = shuffle(buildDeck(this.devilMode, this.rngInt), this.rng);
    this.hands = this.players.map((p) => (p.alive ? deck.splice(0, HAND_SIZE) : []));
    this.tableCard = RANKS[this.rngInt(RANKS.length)];
    this.pile = [];
    this.roundStarted = false;
    this.mustCall = false;
    this.turnSeat = firstSeat;
    this.pushLog(`—— 第 ${this.roundNo} 局开始，本局目标牌【${this.tableCard}】，由 ${this.name(firstSeat)} 先行动 ——`);
  }

  // ---------- 玩家动作 ----------

  playCards(seat, cardIds) {
    this.assertTurn(seat);
    if (this.mustCall) throw new GameError('只剩你一人有手牌，你必须质疑上家');
    if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 3) {
      throw new GameError('一次只能扣出 1-3 张牌');
    }
    const hand = this.hands[seat];
    const ids = new Set(cardIds);
    if (ids.size !== cardIds.length) throw new GameError('不能重复选择同一张牌');
    const cards = [];
    for (const id of cardIds) {
      const card = hand.find((c) => c.id === id);
      if (!card) throw new GameError('选择的牌不在你的手牌中');
      cards.push(card);
    }
    if (cards.some((c) => c.devil) && cards.length !== 1) {
      throw new GameError('恶魔牌只能单独打出');
    }
    for (const c of cards) hand.splice(hand.indexOf(c), 1);
    this.pile.push({ seat, cards });
    this.roundStarted = true;
    this.pushLog(`${this.name(seat)} 扣下了 ${cards.length} 张牌`);
    return this.afterAction(seat, { type: 'play', seat, count: cards.length });
  }

  callLiar(seat) {
    this.assertTurn(seat);
    if (this.pile.length === 0) throw new GameError('本局还没有人出牌，无法质疑');
    const caller = seat;
    const entry = this.pile[this.pile.length - 1];
    const revealed = entry.cards;

    const devilTriggered =
      this.devilMode && revealed.length === 1 && revealed[0].devil && revealed[0].rank === this.tableCard;

    let punishedSeat;
    let isLie;
    if (devilTriggered) {
      isLie = false;
      punishedSeat = caller; // 恶魔现身：质疑者受罚
    } else {
      isLie = revealed.some((c) => c.rank !== this.tableCard && c.rank !== 'Joker');
      punishedSeat = isLie ? entry.seat : caller;
    }

    this.pushLog(
      `${this.name(caller)} 质疑 ${this.name(entry.seat)}！翻开：${revealed.map((c) => this.cardText(c)).join(' ')}`
    );
    if (devilTriggered) {
      this.pushLog(`😈 恶魔现身！${this.name(caller)} 质疑失败，全桌还有人手牌的都要陪拉扳机！`);
    } else {
      this.pushLog(
        isLie
          ? `验牌结果：${this.name(entry.seat)} 说谎成立！`
          : `验牌结果：全是真牌，${this.name(caller)} 质疑失败！`
      );
    }

    // 结算轮盘
    const punishments = [];
    const main = this.roulette(punishedSeat, this.players[punishedSeat].punishments + 1, false);
    this.players[punishedSeat].punishments += 1;
    punishments.push(main);

    if (devilTriggered) {
      for (const p of this.players) {
        if (p.seat === entry.seat) continue; // 恶魔出牌者安全
        if (p.seat === caller) continue; // 质疑者已在上面受罚
        if (!p.alive || this.hands[p.seat].length === 0) continue; // 死亡/空手幸免
        punishments.push(this.roulette(p.seat, 1, true));
      }
    }

    for (const pr of punishments) {
      if (pr.died) {
        this.players[pr.seat].alive = false;
        this.pushLog(`💀 ${this.name(pr.seat)} 中弹身亡！`);
      }
    }

    // 流转
    const alive = this.players.filter((p) => p.alive);
    let newRound = null;
    if (alive.length <= 1) {
      this.phase = 'over';
      this.winner = alive.length === 1 ? alive[0].seat : null;
      this.pushLog(
        this.winner === null
          ? '—— 全桌覆灭，无人幸存 ——'
          : `—— 游戏结束，最后的幸存者是 ${this.name(this.winner)} ——`
      );
    } else {
      const first = this.players[punishedSeat].alive ? punishedSeat : this.aliveSeatAfter(punishedSeat);
      this.startRound(first);
      newRound = { no: this.roundNo, tableCard: this.tableCard, firstSeat: first };
    }

    return {
      type: 'challenge',
      caller,
      played: { seat: entry.seat, cards: revealed },
      isLie,
      devilTriggered,
      punishments, // [{seat, pulls, forced, died, deathPull}]
      gameOver: this.phase === 'over',
      winner: this.winner,
      newRound,
    };
  }

  // ---------- 内部 ----------

  roulette(seat, pulls, forced) {
    const b = this.rngInt(6); // 子弹位：0..5，同次惩罚内不重转
    const died = b < pulls;
    return {
      seat,
      pulls,
      forced,
      died,
      deathPull: died ? b + 1 : null, // 第几发响（1-based），空枪为 null
    };
  }

  // 动作后的回合推进；返回动作结果（roundExhausted 表示全场无人有牌直接进入新一局）
  afterAction(seat, result) {
    const next = this.firstActiveAfter(seat);
    if (next !== null) {
      this.turnSeat = next;
    } else if (this.hands[seat].length > 0) {
      this.turnSeat = seat; // 只剩自己有牌：轮到自己，必须质疑
    } else {
      // 全场无人有牌：本局无惩罚直接结束
      this.pushLog('全场手牌打空，本局直接结束');
      this.startRound(seat);
      return { ...result, roundExhausted: true, newRound: { no: this.roundNo, tableCard: this.tableCard } };
    }
    this.mustCall = this.activeSeats().length === 1 && this.activeSeats()[0] === this.turnSeat;
    if (this.mustCall) this.pushLog(`只剩 ${this.name(this.turnSeat)} 有手牌，必须质疑上家`);
    return result;
  }

  assertTurn(seat) {
    if (this.phase !== 'round') throw new GameError('当前不在对局中');
    if (seat !== this.turnSeat) throw new GameError('还没轮到你');
  }

  firstActiveAfter(seat) {
    const n = this.players.length;
    for (let i = 1; i < n; i++) {
      const s = (seat + i) % n;
      if (this.players[s].alive && this.hands[s].length > 0) return s;
    }
    return null;
  }

  activeSeats() {
    const out = [];
    for (const p of this.players) {
      if (p.alive && this.hands[p.seat].length > 0) out.push(p.seat);
    }
    return out;
  }

  aliveSeatAfter(seat) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      if (this.players[s].alive) return s;
    }
    return seat;
  }

  name(seat) {
    return this.players[seat].name;
  }

  cardText(card) {
    if (card.devil) return `😈${card.rank}`;
    if (card.rank === 'Joker') return '🃏王';
    return `${card.rank}${card.suit}`;
  }

  pushLog(text) {
    this.log.push(text);
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  // ---------- 对外快照 ----------

  // 按座位消毒：只暴露该座位应见的信息（自己的手牌、他人的张数、牌堆只给数量）
  sanitizedFor(seat) {
    return {
      phase: this.phase,
      mode: this.devilMode ? 'devil' : 'normal',
      roundNo: this.roundNo,
      tableCard: this.tableCard,
      you: seat,
      turnSeat: this.turnSeat,
      mustCall: this.mustCall,
      yourTurn: this.phase === 'round' && this.turnSeat === seat,
      canPlay: this.phase === 'round' && this.turnSeat === seat && !this.mustCall,
      canCall: this.phase === 'round' && this.turnSeat === seat && this.pile.length > 0,
      hand: this.hands[seat] || [],
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        isBot: p.isBot,
        alive: p.alive,
        punishments: p.punishments,
        handCount: this.hands[p.seat].length,
        connected: p.connected,
      })),
      pile: {
        total: this.pile.reduce((s, e) => s + e.cards.length, 0),
        plays: this.pile.map((e) => ({ seat: e.seat, count: e.cards.length })),
      },
      lastPlay:
        this.pile.length > 0
          ? { seat: this.pile[this.pile.length - 1].seat, count: this.pile[this.pile.length - 1].cards.length }
          : null,
      log: this.log.slice(-40),
      winner: this.phase === 'over' ? this.winner : undefined,
    };
  }
}

Game.GameError = GameError;
Game.HAND_SIZE = HAND_SIZE;
Game.TRUTHS_PER_DECK = TRUTHS_PER_DECK;

module.exports = { Game, GameError, HAND_SIZE, TRUTHS_PER_DECK };
