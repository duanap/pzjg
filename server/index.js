'use strict';

const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const rooms = require('./rooms');

const app = express();
const httpServer = require('http').createServer(app);
const io = new Server(httpServer, { cors: { origin: true } });

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', commit: process.env.RELEASE_COMMIT || null });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

rooms.init(io);

function parseLobbyPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('请求参数无效');
  }
  if ((payload.name !== undefined && typeof payload.name !== 'string') ||
      (payload.code !== undefined && typeof payload.code !== 'string')) {
    throw new Error('请求参数无效');
  }
  return payload;
}

io.on('connection', (socket) => {
  let roomCode = null;

  const leaveCurrentRoom = () => {
    if (!roomCode) return;
    const room = rooms.getRoom(roomCode);
    const code = roomCode;
    roomCode = null;
    socket.leave(code); // 先退出广播组，避免离开触发的广播再送达自己
    if (room) room.onDisconnect(socket.id);
  };

  socket.on('lobby:create', (payload = {}) => {
    try {
      const { name } = parseLobbyPayload(payload);
      leaveCurrentRoom();
      const room = rooms.createRoom(socket.id, name);
      roomCode = room.code;
      socket.join(room.code);
      socket.emit('room:state', room.roomView(socket.id));
    } catch (e) {
      socket.emit('err', { message: e.message });
    }
  });

  socket.on('lobby:join', (payload = {}) => {
    try {
      const { code, name } = parseLobbyPayload(payload);
      const room = rooms.getRoom(code);
      if (!room) throw new Error('房间不存在，检查房号是否输对');
      const seatIdx = room.seatOfSocket(socket.id);
      if (seatIdx === -1) {
        leaveCurrentRoom(); // 先退掉旧房，避免旧房把 socket 视为断线
        const idx = room.addHuman(socket.id, name);
        if (idx === -1) throw new Error('房间已满或对局进行中');
      }
      roomCode = room.code;
      socket.join(room.code);
      room.broadcastRoom();
    } catch (e) {
      socket.emit('err', { message: e.message });
    }
  });

  socket.on('room:leave', () => leaveCurrentRoom());

  // 以下动作需要先在房间里
  const requireRoom = (fn) => {
    return (payload) => {
      try {
        const room = roomCode && rooms.getRoom(roomCode);
        if (!room) throw new Error('你不在任何房间里');
        fn(room, payload || {});
      } catch (e) {
        socket.emit('err', { message: e.message });
      }
    };
  };

  const requireHost = (fn) => {
    return requireRoom((room, payload) => {
      const seat = room.seatOfSocket(socket.id);
      if (seat === -1 || seat !== room.hostSeat) throw new Error('只有房主能执行该操作');
      fn(room, seat, payload);
    });
  };

  socket.on('room:mode', requireHost((room, seat, payload) => room.setMode(payload.mode, seat)));
  socket.on('room:add_bot', requireHost((room, seat) => {
    const idx = room.addBot();
    if (idx === -1) throw new Error('没有空座位了');
  }));
  socket.on('room:kick', requireHost((room, seat, payload) => room.kick(payload.seat)));
  socket.on('room:start', requireHost((room, seat) => room.startGame(seat)));
  socket.on('room:rematch', requireHost((room, seat) => room.rematch(seat)));

  socket.on('game:play', requireRoom((room, payload) => room.humanPlay(socket.id, payload.cardIds)));
  socket.on('game:call', requireRoom((room) => room.humanCall(socket.id)));

  socket.on('disconnect', () => leaveCurrentRoom());
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
httpServer.listen(PORT, HOST, () => {
  console.log(`🃏 骗子酒馆已开张: http://localhost:${PORT}`);
});
