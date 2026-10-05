'use strict';

// 房间管理：座位、广播、行动定时器、断线机器人接管、结算动画节奏。
// 所有 setTimeout 都登记在 Room 上，终局/解散统一清理，防止泄漏。
// 约定：座位始终紧凑排列（移除后重排），因此房间座位号 === 引擎座位号。

const crypto = require('crypto');
const { Game, GameError } = require('./game/engine');
const bots = require('./game/bots');

const ROOM_CAP = 4;
const TURN_MS = 30 * 1000; // 人类回合限时
const BOT_DELAY = [1200, 3000]; // 机器人思考区间 ms
const CHALLENGE_REVEAL_MS = 1800; // 验牌动画
const PER_PULL_MS = 1300; // 每发扳机动画
const AFTER_PUNISH_MS = 1600; // 惩罚后余韵

const AVATARS = ['🐭', '🐔', '🦊', '🐻', '🐺', '🐗', '🦉', '🐍', '🦇', '🐸', '🐷', '🐙'];
const BOT_NAMES = ['醉汉老八', '独眼杰克', '红发安妮', '沉默的鲍勃', '老千阿陈', '赌徒老K', '寡妇玛莎', '扒手小六'];

let io = null;
const rooms = new Map();

function randInt(n) {
  return crypto.randomInt(n);
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += alphabet[randInt(alphabet.length)];
  } while (rooms.has(code));
  return code;
}

function later(room, fn, ms) {
  const t = setTimeout(() => {
    room.timers.delete(t);
    fn();
  }, ms);
  room.timers.add(t);
  return t;
}

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers.clear();
  room.turnTimer = null;
}

function newSeat({ name, isBot }) {
  return {
    socketId: null,
    name: String(name || '无名氏').slice(0, 12),
    isBot: !!isBot,
    avatar: AVATARS[randInt(AVATARS.length)],
    connected: !isBot,
  };
}

class Room {
  constructor(code) {
    this.code = code;
    this.seats = []; // 紧凑排列，尾部补 null 为空位
    this.hostSeat = 0;
    this.mode = 'normal';
    this.game = null;
    this.timers = new Set();
    this.turnTimer = null;
    this.turnEndsAt = null;
    this.animating = false;
    this.createdAt = Date.now();
  }

  // ---- 座位 ----

  filledSeats() {
    return this.seats.filter(Boolean);
  }

  firstEmptySeat() {
    for (let i = 0; i < ROOM_CAP; i++) if (!this.seats[i]) return i;
    return -1;
  }

  seatOfSocket(socketId) {
    return this.seats.findIndex((s) => s && s.socketId === socketId);
  }

  compactSeats() {
    this.seats = this.seats.filter(Boolean);
    while (this.seats.length < ROOM_CAP) this.seats.push(null);
    if (!this.seats[this.hostSeat]) {
      const next = this.seats.findIndex(Boolean);
      this.hostSeat = next === -1 ? 0 : next;
    }
  }

  addHuman(socketId, name) {
    if (this.game && this.game.phase === 'round') return -1; // 对局中不加人
    const idx = this.firstEmptySeat();
    if (idx === -1) return -1;
    const seat = newSeat({ name, isBot: false });
    seat.socketId = socketId;
    this.seats[idx] = seat;
    this.broadcastRoom();
    return idx;
  }

  addBot() {
    if (this.game && this.game.phase === 'round') return -1;
    const idx = this.firstEmptySeat();
    if (idx === -1) return -1;
    const used = new Set(this.filledSeats().map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `酒客${idx + 1}号`;
    this.seats[idx] = newSeat({ name, isBot: true });
    this.broadcastRoom();
    return idx;
  }

  removeSeat(idx) {
    if (!this.seats[idx]) return;
    if (this.game && this.game.phase === 'round') {
      // 对局中的离开走断线接管路径，不应直接移除；兜底回到大厅
      this.endGameToLobby();
    }
    const name = this.seats[idx].name;
    this.seats[idx] = null;
    this.compactSeats();
    if (this.filledSeats().length === 0) {
      destroyRoom(this.code);
      return;
    }
    if (this.game) this.endGameToLobby(); // 有座位变动时结束已收尾的对局视图
    this.pushNotice(`${name} 离开了房间`);
    this.broadcastRoom();
  }

  kick(seatIdx) {
    if (this.game && this.game.phase === 'round') throw new GameError('对局进行中不能移除座位');
    const s = this.seats[seatIdx];
    if (!s) throw new GameError('该座位是空的');
    if (seatIdx === this.hostSeat) throw new GameError('不能移除自己');
    if (s.socketId && io) io.to(s.socketId).emit('game:notice', { text: '你被房主移出了房间', action: 'kick' });
    this.removeSeat(seatIdx);
  }

  setMode(mode, bySeat) {
    if (bySeat !== this.hostSeat) throw new GameError('只有房主能切换模式');
    if (this.game && this.game.phase === 'round') throw new GameError('对局进行中不能切换模式');
    if (mode !== 'normal' && mode !== 'devil') throw new GameError('未知模式');
    this.mode = mode;
    this.broadcastRoom();
  }

  // ---- 对局 ----

  canStart() {
    return this.filledSeats().length >= 2;
  }

  startGame(bySeat) {
    if (bySeat !== this.hostSeat) throw new GameError('只有房主能开始游戏');
    if (this.game && this.game.phase === 'round') throw new GameError('对局已经在进行中');
    if (!this.canStart()) throw new GameError('至少需要 2 名玩家');
    clearTimers(this);
    this.animating = false;
    this.turnEndsAt = null;
    this.game = new Game({
      players: this.seats.map((s) => (s ? { name: s.name, isBot: s.isBot, connected: s.connected } : null)).filter(Boolean),
      devilMode: this.mode === 'devil',
    });
    this.game.startGame();
    this.armTurn();
    this.broadcastRoom();
    this.broadcastState();
  }

  rematch(bySeat) {
    if (bySeat !== this.hostSeat) throw new GameError('只有房主能开始新一局');
    if (!this.game || this.game.phase !== 'over') throw new GameError('当前没有已结束的对局');
    this.startGame(bySeat);
  }

  endGameToLobby() {
    clearTimers(this);
    this.animating = false;
    this.turnEndsAt = null;
    this.game = null;
    this.broadcastRoom();
  }

  // ---- 动作入口（来自 socket 或机器人） ----

  assertPlaying() {
    if (!this.game || this.game.phase !== 'round') throw new GameError('当前不在对局中');
  }

  humanPlay(socketId, cardIds) {
    this.assertPlaying();
    const seat = this.seatOfSocket(socketId);
    if (seat === -1) throw new GameError('你不在房间里');
    const res = this.game.playCards(seat, cardIds);
    this.afterAction(res);
  }

  humanCall(socketId) {
    this.assertPlaying();
    const seat = this.seatOfSocket(socketId);
    if (seat === -1) throw new GameError('你不在房间里');
    const res = this.game.callLiar(seat);
    this.afterAction(res);
  }

  afterAction(res) {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.timers.delete(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnEndsAt = null;

    if (res.type === 'play') {
      if (res.roundExhausted) {
        // 全场空手直接进新一局：短促停顿后继续
        this.animating = true;
        later(this, () => {
          this.animating = false;
          this.armTurn();
          this.broadcastState();
        }, 1200);
      } else {
        this.armTurn();
        this.broadcastState();
      }
      return;
    }

    // challenge：先广播验牌事件供客户端播动画，再延迟推送新状态
    const payload = {
      caller: res.caller,
      played: res.played,
      isLie: res.isLie,
      devilTriggered: res.devilTriggered,
      punishments: res.punishments,
    };
    this.animating = true;
    if (io) io.to(this.code).emit('game:challenge', payload);
    const animMs =
      CHALLENGE_REVEAL_MS + res.punishments.reduce((s, p) => s + p.pulls, 0) * PER_PULL_MS + AFTER_PUNISH_MS;
    later(this, () => {
      this.animating = false;
      if (res.gameOver) {
        this.broadcastState();
        if (io) io.to(this.code).emit('game:over', { winner: res.winner });
      } else {
        this.armTurn();
        this.broadcastState();
      }
    }, animMs);
  }

  // ---- 回合调度 ----

  armTurn() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.timers.delete(this.turnTimer);
      this.turnTimer = null;
    }
    if (!this.game || this.game.phase !== 'round') return;
    const seat = this.game.turnSeat;
    const player = this.game.players[seat];
    const [minMs, range] = BOT_DELAY;
    const delay = player.isBot ? minMs + randInt(range) : TURN_MS;
    this.turnEndsAt = player.isBot ? null : Date.now() + TURN_MS;
    this.turnTimer = later(this, () => this.takeTurn(seat), delay);
  }

  takeTurn(seat) {
    this.turnTimer = null;
    if (!this.game || this.game.phase !== 'round') return;
    if (this.game.turnSeat !== seat) return;
    const view = this.game.sanitizedFor(seat);
    const action = bots.decide(view);
    if (!action) return;
    try {
      const res =
        action.type === 'call' ? this.game.callLiar(seat) : this.game.playCards(seat, action.cardIds);
      this.afterAction(res);
    } catch (e) {
      // 托底动作意外非法时重新调度，避免死局
      this.armTurn();
    }
  }

  // ---- 广播 ----

  broadcastRoom() {
    if (!io) return;
    for (const s of this.seats) {
      if (s && s.socketId) io.to(s.socketId).emit('room:state', this.roomView(s.socketId));
    }
  }

  roomView(forSocketId) {
    return {
      code: this.code,
      mode: this.mode,
      hostSeat: this.hostSeat,
      you: forSocketId ? this.seatOfSocket(forSocketId) : -1,
      phase: this.game ? (this.game.phase === 'round' ? 'playing' : this.game.phase) : 'lobby',
      seats: this.seats.map((s, i) =>
        s ? { seat: i, name: s.name, isBot: s.isBot, avatar: s.avatar, connected: s.connected } : null
      ),
      canStart: this.canStart(),
    };
  }

  broadcastState() {
    if (!this.game || !io) return;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (!s || !s.socketId) continue;
      const view = this.game.sanitizedFor(i);
      view.turnEndsAt = this.game.turnSeat === i ? this.turnEndsAt || null : null;
      io.to(s.socketId).emit('game:state', view);
    }
  }

  pushNotice(text) {
    if (this.game) this.game.pushLog(text);
    if (io) io.to(this.code).emit('game:notice', { text });
  }

  // ---- 断线 ----

  onDisconnect(socketId) {
    const idx = this.seatOfSocket(socketId);
    if (idx === -1) return;
    const seat = this.seats[idx];
    seat.connected = false;
    if (this.game && this.game.phase === 'round') {
      // 座位交给机器人接管，游戏继续
      seat.isBot = true;
      seat.socketId = null;
      this.pushNotice(`${seat.name} 断线，机器人接管了他的手牌…`);
      this.broadcastRoom();
      // 若正好轮到他，重新按机器人节奏调度
      if (!this.animating && this.game.turnSeat === idx) this.armTurn();
      return;
    }
    this.removeSeat(idx);
  }
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (room) clearTimers(room);
  rooms.delete(code);
}

function createRoom(socketId, name) {
  const code = genCode();
  const room = new Room(code);
  rooms.set(code, room);
  room.addHuman(socketId, name);
  room.hostSeat = room.seatOfSocket(socketId);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

// 兜底清理：长时间无人且无对局的房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const hasHuman = room.seats.some((s) => s && s.socketId);
    if (!hasHuman && (!room.game || room.game.phase !== 'round') && now - room.createdAt > 30 * 60 * 1000) {
      destroyRoom(code);
    }
  }
}, 60 * 1000).unref();

module.exports = {
  init(ioInstance) {
    io = ioInstance;
  },
  createRoom,
  getRoom,
  destroyRoom,
  ROOM_CAP,
};
