'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { io } = require('socket.io-client');
let server;
let base;
let stderr = '';
test.before(async () => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (data) => { stderr += data; });
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(() => { throw new Error(stderr); }),
  ]);
});
test.after(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
});
test('health endpoint reports a running process', async () => {
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('malformed lobby payloads are rejected without terminating the server', { timeout: 10000 }, async (t) => {
  const client = io(base, { reconnection: false });
  t.after(() => client.close());
  await once(client, 'connect');
  for (const event of ['lobby:create', 'lobby:join']) {
    for (const payload of [null, 42, 'bad', []]) {
      const response = once(client, 'err');
      client.emit(event, payload);
      const result = await Promise.race([
        response.then(([value]) => value),
        once(server, 'exit').then(() => ({ crashed: stderr })),
      ]);
      assert.equal(result.crashed, undefined, result.crashed);
      assert.equal(typeof result.message, 'string');
    }
  }
  const created = once(client, 'room:state');
  client.emit('lobby:create', { name: 'Healthy' });
  const [view] = await created;
  assert.equal(view.you, 0);
  assert.equal(view.seats[0].name, 'Healthy');
});
