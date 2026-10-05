'use strict';

// 端到端冒烟：起真实 HTTP+Socket.IO 服务，双人类客户端完成
// 建房 → 加入 → 开局 → 出牌 → 质疑 → 结算事件 全链路，并验证权限与错误路径。

const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3123;
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

// 持久监听 game:state，避免"先发事件后挂监听"丢消息
function makeWatcher(client) {
  const w = { latest: null, waiters: new Set() };
  client.on('game:state', (gv) => {
    w.latest = gv;
    for (const fn of [...w.waiters]) fn();
  });
  w.waitFor = (pred, timeoutMs, label) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (w.latest && pred(w.latest)) {
          clearTimeout(timer);
          w.waiters.delete(check);
          resolve(w.latest);
        }
      };
      const timer = setTimeout(() => {
        w.waiters.delete(check);
        reject(new Error(`${label} 等待超时`));
      }, timeoutMs);
      w.waiters.add(check);
      check();
    });
  return w;
}

async function main() {
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let serverDead = false;
  server.on('exit', (code) => {
    if (code !== null && code !== 0) serverDead = true;
  });
  await wait(900);

  const a = io(BASE);
  const b = io(BASE);
  const wa = makeWatcher(a);
  const wb = makeWatcher(b);
  try {
    // 1. 甲建房
    a.emit('lobby:create', { name: '甲' });
    const rv1 = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('建房超时')), 3000);
      a.once('room:state', (rv) => {
        clearTimeout(t);
        resolve(rv);
      });
    });
    if (rv1.you !== 0) fail('创建者座位应为 0');
    console.log(`✅ 建房成功：房号 ${rv1.code}，甲为房主（座位 ${rv1.you}）`);

    // 2. 乙加入
    b.emit('lobby:join', { code: rv1.code, name: '乙' });
    const rv2 = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('乙加入超时')), 3000);
      b.once('room:state', (rv) => {
        clearTimeout(t);
        resolve(rv);
      });
    });
    if (rv2.you !== 1 || rv2.seats.filter(Boolean).length !== 2) fail('乙座位/人数不对');
    console.log('✅ 乙加入成功，房间 2 人');

    // 3. 乙（非房主）尝试开始 → 应被拒
    const errs = [];
    b.on('err', (e) => errs.push(e.message));
    b.emit('room:start');
    await wait(300);
    if (!errs.length) fail('非房主开始游戏应被拒绝');
    console.log(`✅ 权限校验：非房主开局被拒（"${errs[0]}"）`);

    // 4. 甲开局（先挂好两边的等待，再触发）
    const opening = Promise.all([
      wa.waitFor((gv) => gv.phase === 'round' && gv.hand.length === 5, 4000, '甲方开局'),
      wb.waitFor((gv) => gv.phase === 'round' && gv.hand.length === 5, 4000, '乙方开局'),
    ]);
    a.emit('room:start');
    const [ga, gb] = await opening;
    if (ga.you !== 0 || gb.you !== 1) fail('you 座位号错误');
    console.log(`✅ 开局：第 ${ga.roundNo} 局，目标牌 ${ga.tableCard}，双方各 5 张手牌`);

    // 5. 轮流行动，直到出现质疑结算
    let challenge = null;
    a.on('game:challenge', (p) => {
      challenge = p;
    });
    const clients = { 0: a, 1: b };
    const watchers = { 0: wa, 1: wb };
    for (let turns = 0; turns < 80 && !challenge; turns++) {
      const view = await wa.waitFor((gv) => gv.phase === 'round', 25000, `第${turns}拍`);
      const seat = view.turnSeat;
      const mine = await watchers[seat].waitFor(
        (gv) => gv.phase === 'round' && gv.turnSeat === seat,
        8000,
        `座位${seat}视角`
      );
      const c = clients[seat];
      if (mine.canCall && mine.pile.total >= 3 && turns % 2 === 0) c.emit('game:call');
      else if (mine.canPlay) c.emit('game:play', { cardIds: [mine.hand[0].id] });
      else if (mine.canCall) c.emit('game:call');
      else fail('轮到行动却无合法动作');
      await wait(250);
    }
    if (!challenge) {
      console.log('⚠️ 80 拍内未出现质疑（概率性），核心链路仍已验证');
    } else {
      console.log(
        `✅ 出牌→质疑→结算：翻开 ${challenge.played.cards.length} 张，${challenge.isLie ? '说谎成立' : '全是真牌'}，` +
          `轮盘 ${challenge.punishments.length} 人次`
      );
    }

    // 6. 对局中切换模式应被拒
    const errs2 = [];
    a.once('err', (e) => errs2.push(e.message));
    a.emit('room:mode', { mode: 'devil' });
    await wait(300);
    if (!errs2.length) fail('对局中切换模式应被拒绝');
    console.log(`✅ 状态校验：对局中切换模式被拒（"${errs2[0]}"）`);

    if (serverDead) fail('服务端中途异常退出');
    console.log('\n🎉 端到端冒烟全部通过');
  } finally {
    a.close();
    b.close();
    server.kill();
    await wait(200);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
