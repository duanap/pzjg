'use strict';

/* ═══════════ 全局状态 ═══════════ */

const S = {
  room: null, // room:state
  game: null, // game:state
  selected: new Set(), // 选中的手牌 id
  animating: false,
  overShown: false,
  muted: localStorage.getItem('pzjg_mute') === '1',
};

let mySeat = -1; // 自己的房间座位号（服务端 room:state 下发）

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const socket = io();

/* ═══════════ 音效（WebAudio 程序合成） ═══════════ */

let actx = null;
function audioCtx() {
  if (!actx) {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return null;
    }
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function tone(freq, dur, { type = 'sine', gain = 0.12, delay = 0, slideTo = null } = {}) {
  const ctx = audioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise(dur, { gain = 0.3, delay = 0, cutoff = 1200 } = {}) {
  const ctx = audioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, t0);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
}

function sfx(kind) {
  if (S.muted) return;
  switch (kind) {
    case 'click':
      tone(660, 0.06, { type: 'square', gain: 0.06, slideTo: 440 });
      break;
    case 'tick': // 空枪
      tone(1900, 0.03, { type: 'square', gain: 0.1 });
      tone(1400, 0.04, { type: 'square', gain: 0.08, delay: 0.05 });
      break;
    case 'bang': // 中弹
      noise(0.55, { gain: 0.5, cutoff: 900 });
      tone(60, 0.45, { gain: 0.4, slideTo: 38 });
      break;
    case 'devil':
      tone(220, 0.8, { type: 'sawtooth', gain: 0.16, slideTo: 55 });
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { gain: 0.1, delay: i * 0.13 }));
      break;
    case 'deal':
      noise(0.08, { gain: 0.12, cutoff: 2400 });
      break;
  }
}

/* ═══════════ 屏幕切换 ═══════════ */

function showScreen(name) {
  for (const s of ['lobby', 'room', 'game']) {
    $(`screen-${s}`).classList.toggle('hidden', s !== name);
  }
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function resetToLobby() {
  S.room = null;
  S.game = null;
  S.selected.clear();
  S.overShown = false;
  document.body.classList.remove('devil-mode');
  $('overlay').classList.add('hidden');
  showScreen('lobby');
}

/* ═══════════ 卡牌渲染 ═══════════ */

const TARGET_SUITS = { K: '♠', Q: '♥', A: '♠' };

function cardEl(card) {
  const d = document.createElement('div');
  const isJoker = card.rank === 'Joker';
  const red = card.suit === '♥';
  d.className = 'card' + (isJoker ? ' joker' : '') + (card.devil ? ' devil' : '') + (red ? ' red' : '');
  const corner = document.createElement('div');
  corner.className = 'corner';
  corner.innerHTML = isJoker ? '王' : `${card.rank}<span class="suit">${card.suit}</span>`;
  const center = document.createElement('div');
  center.className = 'center-rank';
  center.textContent = isJoker ? '🃏' : card.rank;
  d.appendChild(corner);
  d.appendChild(center);
  if (card.devil) {
    const badge = document.createElement('div');
    badge.className = 'devil-badge';
    badge.textContent = '😈';
    d.appendChild(badge);
  }
  return d;
}

/* ═══════════ Socket 事件 ═══════════ */

socket.on('connect', () => {
  $('btn-create').disabled = false;
  $('btn-join').disabled = false;
});
socket.on('disconnect', () => {
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
});
socket.on('connect_error', () => toast('连接服务器失败，请刷新重试'));

socket.on('err', ({ message }) => toast(message || '操作无效'));

socket.on('game:notice', ({ text, action }) => {
  toast(text);
  if (action === 'kick') resetToLobby();
});

socket.on('room:state', (rv) => {
  if (rv.you === -1) return; // 已不在该房间（被踢/已退出），忽略残留广播
  S.room = rv;
  mySeat = rv.you;
  if (rv.phase === 'lobby') {
    showScreen('room');
    renderRoom();
  }
});

socket.on('game:state', (gv) => {
  const wasOver = S.game && S.game.phase === 'over';
  S.game = gv;
  S.selected.clear();
  document.body.classList.toggle('devil-mode', gv.mode === 'devil');
  if (gv.phase === 'round' && gv.roundNo === 1 && !wasOver) sfx('deal');
  if (gv.phase !== 'over') S.overShown = false;
  showScreen('game');
  renderGame();
  if (gv.phase === 'over' && !S.overShown && !S.animating) {
    S.overShown = true;
    showGameOver(gv.winner);
  }
});

socket.on('game:challenge', (payload) => {
  playChallenge(payload);
});

socket.on('game:over', ({ winner }) => {
  if (!S.overShown && !S.animating) {
    S.overShown = true;
    showGameOver(winner);
  }
});

/* ═══════════ 大厅 ═══════════ */

(function initLobby() {
  const nick = $('nickname');
  nick.value = localStorage.getItem('pzjg_name') || '';
  $('btn-create').onclick = () => {
    const name = nick.value.trim() || '无名酒客';
    localStorage.setItem('pzjg_name', name);
    sfx('click');
    socket.emit('lobby:create', { name });
  };
  $('btn-join').onclick = () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('请输入 4 位房号');
    const name = nick.value.trim() || '无名酒客';
    localStorage.setItem('pzjg_name', name);
    sfx('click');
    socket.emit('lobby:join', { code, name });
  };
  $('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });
})();

/* ═══════════ 房间 ═══════════ */

function renderRoom() {
  const rv = S.room;
  if (!rv) return;
  $('room-code').textContent = rv.code;

  const host = mySeat === rv.hostSeat;
  const lobby = rv.phase === 'lobby';

  // 座位
  const box = $('room-seats');
  box.innerHTML = '';
  rv.seats.forEach((s, i) => {
    if (s) {
      const el = document.createElement('div');
      el.className = 'seat' + (i === rv.hostSeat ? ' host' : '');
      el.innerHTML = `<span class="avatar">${s.avatar}</span>
        <span class="s-name">${escapeHtml(s.name)}${s.isBot ? ' 🤖' : ''}${s.connected === false ? ' ⚠️' : ''}</span>
        <span class="s-tag">${i === rv.hostSeat ? '房主' : s.isBot ? '机器人' : '玩家'}</span>`;
      if (host && lobby && i !== mySeat && !s.isBot) {
        const kick = document.createElement('span');
        kick.className = 'seat-kick';
        kick.textContent = '✕';
        kick.title = '移出座位';
        kick.onclick = () => socket.emit('room:kick', { seat: i });
        el.appendChild(kick);
      }
      box.appendChild(el);
    } else {
      const el = document.createElement('div');
      const canAdd = host && lobby;
      el.className = 'seat ' + (canAdd ? 'seat-action' : 'seat-empty');
      el.innerHTML = canAdd ? '<span class="plus">＋</span><span class="s-tag">加机器人</span>' : '<span class="plus">·</span><span class="s-tag">空位</span>';
      if (canAdd) el.onclick = () => socket.emit('room:add_bot');
      box.appendChild(el);
    }
  });

  // 模式
  const modeBox = $('room-mode-box');
  modeBox.classList.toggle('locked', !host || !lobby);
  for (const input of modeBox.querySelectorAll('input')) input.checked = input.value === rv.mode;

  // 按钮
  $('btn-add-bot').style.display = host && lobby ? '' : 'none';
  $('btn-start').style.display = host && lobby ? '' : 'none';
  $('btn-start').disabled = !rv.canStart;
  $('btn-start').textContent = rv.phase === 'over' ? '▶ 再来一局' : '▶ 开始游戏';

  // 提示
  $('room-tip').textContent = !lobby
    ? '对局进行中…'
    : rv.canStart
      ? host
        ? '人齐了，开始吧！'
        : '等待房主开始游戏…'
      : '至少需要 2 名玩家（可以加机器人）';
}

(function initRoom() {
  $('btn-copy').onclick = () => {
    const code = S.room && S.room.code;
    if (!code) return;
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('房号已复制'));
    else toast(`房号：${code}`);
  };
  $('btn-leave').onclick = () => {
    socket.emit('room:leave');
    resetToLobby();
  };
  $('btn-add-bot').onclick = () => socket.emit('room:add_bot');
  $('btn-start').onclick = () => socket.emit('room:start');
  for (const input of document.querySelectorAll('input[name=mode]')) {
    input.onchange = () => {
      if (input.checked) socket.emit('room:mode', { mode: input.value });
    };
  }
})();

/* ═══════════ 牌桌 ═══════════ */

function playerName(seat) {
  const p = S.game && S.game.players[seat];
  return p ? p.name : `座位${seat + 1}`;
}

function avatarOf(seat) {
  const p = S.game && S.game.players[seat];
  if (p && S.room && S.room.seats[seat]) return S.room.seats[seat].avatar;
  return '🎲';
}

function renderGame() {
  const g = S.game;
  if (!g) return;
  mySeat = g.you;

  // 头部
  $('g-round').textContent = `第 ${g.roundNo} 局`;
  $('g-mode').textContent = g.mode === 'devil' ? '😈 恶魔牌局' : '🎴 普通牌局';
  $('g-mode').className = 'g-mode' + (g.mode === 'devil' ? ' devil' : '');
  const tc = $('target-card');
  tc.innerHTML = `${g.tableCard}<span class="suit">${TARGET_SUITS[g.tableCard] || ''}</span>`;

  // 牌堆
  $('pile-count').textContent = `${g.pile.total} 张`;
  $('last-play').textContent = g.lastPlay
    ? `「${playerName(g.lastPlay.seat)}」扣下了 ${g.lastPlay.count} 张牌`
    : g.phase === 'round'
      ? '等待本局第一个动作…'
      : '对局已结束';

  // 对手座位
  const opp = $('opponents');
  opp.innerHTML = '';
  for (const p of g.players) {
    if (p.seat === g.you) continue;
    opp.appendChild(seatCardEl(p));
  }

  // 自己面板
  const me = g.players[g.you];
  $('self-avatar').textContent = avatarOf(g.you);
  $('self-name').textContent = me.name;
  $('self-badges').innerHTML = badgesHtml(me);

  // 手牌
  const hand = $('hand');
  hand.innerHTML = '';
  const myTurn = g.yourTurn && g.phase === 'round' && !S.animating;
  for (const card of g.hand) {
    const el = cardEl(card);
    if (myTurn && g.canPlay) {
      const isSel = S.selected.has(card.id);
      const devilSel = [...S.selected].some((id) => {
        const c = g.hand.find((x) => x.id === id);
        return c && c.devil;
      });
      if (devilSel && !isSel) {
        el.classList.add('disabled');
      } else {
        el.classList.add('selectable');
        el.onclick = () => toggleSelect(card);
      }
      if (isSel) el.classList.add('selected');
    }
    hand.appendChild(el);
  }

  updateButtons();
  renderLog(g.log);
}

function seatCardEl(p) {
  const el = document.createElement('div');
  el.className =
    'seat-card' +
    (S.game.turnSeat === p.seat && S.game.phase === 'round' ? ' turn' : '') +
    (!p.alive ? ' dead' : '');
  const isTurn = S.game.turnSeat === p.seat && S.game.phase === 'round';
  const tags = [];
  if (p.isBot) tags.push('🤖');
  if (p.connected === false && !p.isBot) tags.push('⚠️断线');
  el.innerHTML = `
    <div class="row1">
      <span class="avatar">${avatarOf(p.seat)}</span>
      <span class="pname">${escapeHtml(p.name)}</span>
    </div>
    <div class="row2">
      ${!p.alive ? '<span class="conn-tag">💀 已出局</span>' : `
        <span class="mini-hand">${'<i></i>'.repeat(Math.min(4, p.handCount))}</span>
        <span class="handcount">×${p.handCount}</span>`}
      <span class="badges">${badgesHtml(p)}</span>
    </div>
    <div class="turn-timer" data-seat="${p.seat}">${isTurn ? '' : tags.length ? tags.join(' ') : ''}</div>`;
  return el;
}

function badgesHtml(p) {
  if (p.punishments <= 0) return '';
  const hot = p.punishments >= 2 ? ' hot' : '';
  return `<span class="gun${hot}">🔫×${p.punishments}</span>`;
}

function toggleSelect(card) {
  if (S.animating) return;
  if (S.selected.has(card.id)) {
    S.selected.delete(card.id);
  } else if (card.devil) {
    S.selected.clear();
    S.selected.add(card.id);
  } else {
    const hasDevil = [...S.selected].some((id) => {
      const c = S.game.hand.find((x) => x.id === id);
      return c && c.devil;
    });
    if (hasDevil) return;
    if (S.selected.size >= 3) return toast('一次最多扣 3 张牌');
    S.selected.add(card.id);
  }
  sfx('click');
  renderGame();
}

function updateButtons() {
  const g = S.game;
  if (!g) return;
  const btnPlay = $('btn-play');
  const btnCall = $('btn-call');
  const hint = $('action-hint');
  const myTurn = g.yourTurn && g.phase === 'round' && !S.animating;

  const selCards = [...S.selected].map((id) => g.hand.find((c) => c.id === id)).filter(Boolean);
  const hasDevil = selCards.some((c) => c.devil);
  const playOk = myTurn && g.canPlay && selCards.length >= 1 && (!hasDevil || selCards.length === 1);

  btnPlay.disabled = !playOk;
  btnPlay.textContent = hasDevil && selCards.length === 1 ? '😈 打出恶魔牌' : `🎴 出牌(${selCards.length})`;
  btnCall.disabled = !(myTurn && g.canCall);

  if (!g.phase || g.phase === 'over') hint.textContent = '';
  else if (S.animating) hint.textContent = '';
  else if (!g.yourTurn) hint.textContent = `等待「${playerName(g.turnSeat)}」行动…`;
  else if (g.mustCall) hint.textContent = '只剩你一人有手牌，必须质疑上家！';
  else if (!g.canCall) hint.textContent = '本局第一手，只能出牌';
  else hint.textContent = '扣 1-3 张牌，或质疑上家';
}

(function initGame() {
  $('btn-play').onclick = () => {
    if (!S.selected.size) return;
    $('btn-play').disabled = true;
    $('btn-call').disabled = true;
    socket.emit('game:play', { cardIds: [...S.selected] });
  };
  $('btn-call').onclick = () => {
    $('btn-play').disabled = true;
    $('btn-call').disabled = true;
    socket.emit('game:call');
  };
  $('btn-mute').onclick = () => {
    S.muted = !S.muted;
    localStorage.setItem('pzjg_mute', S.muted ? '1' : '0');
    $('btn-mute').textContent = S.muted ? '🔇' : '🔊';
    if (!S.muted) sfx('click');
  };
  $('btn-mute').textContent = S.muted ? '🔇' : '🔊';
  $('btn-rules').onclick = () => showRulesOverlay();
})();

/* ─── 倒计时 ─── */

setInterval(() => {
  const g = S.game;
  if (!g || g.phase !== 'round' || !g.turnEndsAt) return;
  const el = document.querySelector(`.turn-timer[data-seat="${g.turnSeat}"]`);
  if (!el) return;
  const left = Math.max(0, Math.ceil((g.turnEndsAt - Date.now()) / 1000));
  el.textContent = `⏱ ${left}s`;
  el.classList.toggle('urgent', left <= 5);
}, 250);

/* ─── 战报 ─── */

function logClass(line) {
  if (line.startsWith('——')) return 'round';
  if (line.includes('😈')) return 'devil';
  if (line.includes('中弹身亡')) return 'death';
  if (line.includes('质疑')) return 'call';
  if (line.includes('扣下')) return 'play';
  if (line.includes('说谎成立') || line.includes('质疑失败')) return 'result';
  return '';
}

function renderLog(lines) {
  const box = $('log-list');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = '';
  for (const line of lines) {
    const d = document.createElement('div');
    d.className = 'log-line ' + logClass(line);
    d.textContent = line;
    box.appendChild(d);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ═══════════ 覆盖层动画 ═══════════ */

function showRulesOverlay() {
  const ov = $('overlay');
  ov.classList.remove('hidden');
  ov.innerHTML = `
    <div class="gameover-box">
      <div class="ov-title">📖 规则速览</div>
      <div class="ov-sub" style="line-height:2;max-width:560px;text-align:left">
        ① 每人 5 张牌，本局目标牌在桌面中央（K/Q/A）。<br/>
        ② 轮到你：扣 <b>1-3 张</b>牌宣称全是目标牌（可以撒谎），或<b>质疑</b>上家。<br/>
        ③ 翻牌：混有假牌 → 出牌者上轮盘；全是真牌 → 质疑者上轮盘。<br/>
        ④ 🃏王永远是真牌。被罚次数越多，扣的扳机越多（1/2/3 发递增）。<br/>
        ⑤ 😈恶魔牌只能单独出：被翻开时不算假牌，质疑者受罚，且全桌有手牌的都要陪拉一次扳机。<br/>
        ⑥ 打空手牌本局安全；活到最后即胜利。
      </div>
      <button class="btn btn-dark" id="ov-close">知道了</button>
    </div>`;
  $('ov-close').onclick = () => {
    ov.classList.add('hidden');
    ov.innerHTML = '';
  };
}

function showGameOver(winner) {
  const ov = $('overlay');
  ov.classList.remove('hidden');
  const isDraw = winner === null || winner === undefined;
  const host = !!(S.room && mySeat === S.room.hostSeat);
  sfx(isDraw ? 'devil' : 'win');
  ov.innerHTML = `
    <div class="gameover-box">
      <div class="gameover-crown">${isDraw ? '💀' : '👑'}</div>
      <div class="ov-title">${isDraw ? '全桌覆灭' : '最后的幸存者'}</div>
      ${isDraw ? '' : `<div class="ov-sub" style="font-size:26px;color:var(--gold)">${escapeHtml(playerName(winner))}</div>`}
      <div class="gameover-btns">
        ${host ? '<button class="btn btn-gold" id="btn-rematch">▶ 再来一局</button>' : '<span class="ov-sub">等待房主开始新一局…</span>'}
        <button class="btn btn-dark" id="btn-exit">回到大厅</button>
      </div>
    </div>`;
  if (host) $('btn-rematch').onclick = () => socket.emit('room:rematch');
  $('btn-exit').onclick = () => {
    socket.emit('room:leave');
    resetToLobby();
  };
}

async function playChallenge(p) {
  S.animating = true;
  updateButtons();
  const ov = $('overlay');
  ov.classList.remove('hidden', 'shake');
  sfx('deal');

  // 1) 验牌
  const table = S.game ? S.game.tableCard : null;
  const cardsHtml = [];
  ov.innerHTML = `<div class="ov-title">验 牌</div><div class="reveal-cards" id="reveal-cards"></div><div class="verdict" id="verdict" style="min-height:44px"></div>`;
  const revealBox = $('reveal-cards');
  p.played.cards.forEach((card, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'reveal-card';
    wrap.style.animationDelay = `${i * 0.25}s`;
    const isTruth = card.rank === table || card.rank === 'Joker' || (card.devil && card.rank === table);
    const el = cardEl(card);
    el.classList.add(isTruth ? 'true-card' : 'lie-card');
    const tag = document.createElement('div');
    tag.className = 'reveal-tag ' + (isTruth ? 'ok' : 'lie');
    tag.textContent = isTruth ? '真牌' : '假牌';
    wrap.appendChild(el);
    wrap.appendChild(tag);
    revealBox.appendChild(wrap);
    sfx('click');
  });
  await sleep(1800);

  // 2) 判定横幅
  const verdict = $('verdict');
  if (p.devilTriggered) {
    ov.innerHTML = `<div class="devil-flash">😈</div><div class="verdict devil">恶魔现身！</div>`;
    sfx('devil');
    await sleep(1700);
  } else {
    verdict.textContent = p.isLie ? '说谎成立！' : '全是真牌！';
    verdict.className = 'verdict ' + (p.isLie ? 'liar' : 'truth');
    sfx(p.isLie ? 'devil' : 'tick');
    await sleep(1400);
  }

  // 3) 轮盘队列
  for (let i = 0; i < p.punishments.length; i++) {
    const pr = p.punishments[i];
    await playRoulette(pr, i, p.punishments.length);
  }

  await sleep(500);
  ov.classList.add('hidden');
  ov.innerHTML = '';
  S.animating = false;
  updateButtons();
  // 若 server 已推进到终局而事件早于动画到达，这里兜底弹出结算
  if (S.game && S.game.phase === 'over' && !S.overShown) {
    S.overShown = true;
    showGameOver(S.game.winner);
  }
}

async function playRoulette(pr, idx, total) {
  const ov = $('overlay');
  const who = escapeHtml(playerName(pr.seat));
  const dots = Array.from({ length: pr.pulls }, () => '<span class="pull-dot"></span>').join('');
  ov.innerHTML = `
    <div class="roulette-box">
      <div class="roulette-who">${pr.forced ? `<span class="forced-tag">😈 恶魔逼迫</span><br/>` : ''}「<b>${who}</b>」${pr.forced ? '被迫' : '拿起左轮'}扣下扳机 ×${pr.pulls}</div>
      <div class="roulette-gun" id="rv-gun">🔫</div>
      <div class="pull-dots" id="rv-dots">${dots}</div>
      <div class="pull-result" id="rv-result"></div>
      ${total > 1 ? `<div class="queue-dots">${Array.from({ length: total }, (_, j) => `<span class="queue-dot ${j < idx ? 'past' : j === idx ? 'now' : ''}"></span>`).join('')}</div>` : ''}
    </div>`;

  const gun = $('rv-gun');
  const result = $('rv-result');
  for (let k = 1; k <= pr.pulls; k++) {
    await sleep(1150);
    gun.classList.add('pulling');
    await sleep(160);
    gun.classList.remove('pulling');
    const dot = $('rv-dots').children[k - 1];
    if (k === pr.deathPull) {
      dot.classList.add('bang');
      result.textContent = '砰！！！';
      result.className = 'pull-result bang';
      sfx('bang');
      ov.classList.add('shake');
      setTimeout(() => ov.classList.remove('shake'), 550);
    } else {
      dot.classList.add('done');
      result.textContent = '咔嗒… 空枪';
      result.className = 'pull-result blank';
      sfx('tick');
    }
  }
  if (!pr.died) {
    await sleep(450);
    result.textContent = '侥幸活了下来…';
    result.className = 'pull-result survive';
  }
  await sleep(550);
}

/* ═══════════ 工具 ═══════════ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
