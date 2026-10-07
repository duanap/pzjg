'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../server/rooms');
function makeRoom(t) {
  const room = rooms.createRoom('host', 'Host');
  room.addHuman('guest', 'Guest');
  t.after(() => rooms.destroyRoom(room.code));
  return room;
}
test('disconnected player acts as a bot before the human timeout', async (t) => {
  const room = makeRoom(t);
  room.startGame(0);
  const seat = room.game.turnSeat;
  room.onDisconnect(room.seats[seat].socketId);
  const view = room.game.sanitizedFor(1 - seat);
  assert.equal(view.players[seat].isBot, true);
  assert.equal(view.players[seat].connected, false);
  const until = Date.now() + 5000;
  while (!room.game.pile.length && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(room.game.pile.length, 1);
  assert.equal(room.game.pile[0].seat, seat);
});
test('host disconnect transfers rematch privileges to the remaining human', (t) => {
  const room = makeRoom(t);
  room.startGame(0);
  room.onDisconnect('host');
  assert.equal(room.roomView('guest').hostSeat, 1);
  room.game.phase = 'over';
  room.rematch(1);
  assert.equal(room.game.phase, 'round');
});
test('removing the lobby host chooses a human rather than a bot', (t) => {
  const room = rooms.createRoom('host', 'Host');
  t.after(() => rooms.destroyRoom(room.code));
  room.addBot();
  room.addHuman('guest', 'Guest');
  room.onDisconnect('host');
  assert.equal(room.roomView('guest').hostSeat, room.seatOfSocket('guest'));
  room.setMode('devil', room.seatOfSocket('guest'));
  assert.equal(room.mode, 'devil');
});
test('play and challenge cannot mutate the next round during settlement', (t) => {
  const room = makeRoom(t);
  room.startGame(0);
  room.game.rngInt = (n) => n - 1;
  const first = room.game.turnSeat;
  room.humanPlay(room.seats[first].socketId, [room.game.hands[first][0].id]);
  room.humanCall(room.seats[room.game.turnSeat].socketId);
  const seat = room.game.turnSeat;
  const before = JSON.stringify(room.game.sanitizedFor(seat));
  assert.throws(() => room.humanPlay(room.seats[seat].socketId, [room.game.hands[seat][0].id]), /结算/);
  assert.throws(() => room.humanCall(room.seats[seat].socketId), /结算/);
  assert.equal(JSON.stringify(room.game.sanitizedFor(seat)), before);
});
test('rematch cannot interrupt final settlement', (t) => {
  const room = makeRoom(t);
  room.startGame(0);
  room.game.rngInt = () => 0;
  const seat = room.game.turnSeat;
  room.humanPlay(room.seats[seat].socketId, [room.game.hands[seat][0].id]);
  room.humanCall(room.seats[room.game.turnSeat].socketId);
  assert.equal(room.game.phase, 'over');
  assert.throws(() => room.rematch(0), /结算/);
  assert.equal(room.game.phase, 'over');
});

test('settlement stays locked until the client animation has completed', async (t) => {
  const room = makeRoom(t);
  room.startGame(0);
  room.game.rngInt = (n) => n - 1;
  const seat = room.game.turnSeat;
  room.humanPlay(room.seats[seat].socketId, [room.game.hands[seat][0].id]);
  room.humanCall(room.seats[room.game.turnSeat].socketId);
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.equal(room.animating, true);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(room.animating, false);
  const next = room.game.turnSeat;
  room.humanPlay(room.seats[next].socketId, [room.game.hands[next][0].id]);
  assert.equal(room.game.pile.length, 1);
});
