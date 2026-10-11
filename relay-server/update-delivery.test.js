/**
 * Update delivery contract the client's offline queue relies on.
 *
 *  - `update` frames have their own, larger rate budget: a reconnecting device
 *    replays its queue, answers sync requests and publishes snapshots, and the
 *    shared 100/min control budget used to drop everything past frame 100.
 *  - every update is answered with an ack (or an error) that echoes its msgId,
 *    and the ack only follows a durable write, because it is the client's
 *    licence to delete its queued copy.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 19969;
let child, directory;
const sockets = [];
const payload = (n) => ({ ciphertext: `opaque-${n}`, iv: 'opaque-nonce', tag: 'opaque-tag' });

function collect(socket) {
  const frames = [];
  socket.on('message', (raw) => frames.push(JSON.parse(raw)));
  return frames;
}

async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

async function connect(token, familyId, deviceId) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  sockets.push(socket);
  const frames = collect(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'auth', relayToken: token }));
  await until(() => frames.some((f) => f.type === 'auth_ack'));
  socket.send(JSON.stringify({ type: 'identity', familyId, deviceId }));
  await until(() => frames.some((f) => f.type === 'ack'));
  return { socket, frames };
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantryrun-delivery-test-'));
  const state = path.join(directory, 'state.json');
  const expiresAt = Date.now() + 3600000;
  fs.writeFileSync(state, JSON.stringify({ enrolledDevices: {
    a: { familyId: 'family', deviceId: 'a', expiresAt },
    b: { familyId: 'family', deviceId: 'b', expiresAt },
  } }));
  child = spawn(process.execPath, ['-e', "const net=require('net');const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(port,...args){return listen.call(this,port,'127.0.0.1',...args)};require('./server.js')"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), RELAY_PORT: String(PORT), POOL_PORT: String(PORT + 1), RELAY_DATA_DIR: directory, RELAY_STATE_FILE: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('test relay did not start: ' + output);
});

afterAll(async () => {
  sockets.forEach((s) => s.terminate());
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('a 150-update burst is stored, relayed and acked frame by frame', async () => {
  const a = await connect('a', 'family', 'a');
  const b = await connect('b', 'family', 'b');
  for (let i = 0; i < 150; i++) {
    a.socket.send(JSON.stringify({ type: 'update', familyId: 'family', deviceId: 'a', listId: 'list', payload: payload(i), msgId: `m${i}` }));
  }
  await until(() => a.frames.filter((f) => f.msgId).length >= 150);

  const answers = a.frames.filter((f) => f.msgId);
  expect(answers.filter((f) => f.type === 'error')).toEqual([]);
  expect(answers.map((f) => f.msgId)).toEqual(Array.from({ length: 150 }, (_, i) => `m${i}`));
  await until(() => b.frames.filter((f) => f.type === 'update').length >= 150);

  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'data', 'encrypted-updates.json'), 'utf-8'));
  expect(stored.family.list).toHaveLength(150);
  a.socket.close();
  b.socket.close();
});

test('an update the relay cannot store is answered with an error for its msgId, not an ack', async () => {
  const a = await connect('a', 'family', 'a');
  fs.writeFileSync(path.join(directory, 'data', 'encrypted-updates.json'), '{ damaged');
  a.socket.send(JSON.stringify({ type: 'update', familyId: 'family', deviceId: 'a', listId: 'list', payload: payload('x'), msgId: 'unstorable' }));
  await until(() => a.frames.some((f) => f.msgId === 'unstorable'));
  const answer = a.frames.find((f) => f.msgId === 'unstorable');
  expect(answer.type).toBe('error');
  expect(typeof answer.retryAfterMs).toBe('number');
  a.socket.close();
});
