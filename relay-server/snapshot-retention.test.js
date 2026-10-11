/**
 * Snapshots: a list's history on the relay must outlive retention.
 *
 * Stored updates are aged out after UPDATE_TTL_MS (30 days). With nothing but
 * individual updates stored, a list nobody edited for a month had no copy left
 * on the relay, and a device that joined afterwards never received it — peers
 * only answer sync requests for lists the asker already knows.
 *
 * Clients now publish an encrypted full-state snapshot per list after the
 * history replay (`history_complete`). The relay replaces the entries the
 * snapshot covers (seq <= coversSeq) and never ages out a list's latest
 * snapshot.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const payload = (n) => ({ ciphertext: `c${n}`, iv: `i${n}`, tag: `t${n}` });
const DAY = 86_400_000;

describe('encrypted-store snapshots', () => {
  let dir;
  let prevDataDir;
  let store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-store-test-'));
    prevDataDir = process.env.RELAY_DATA_DIR;
    process.env.RELAY_DATA_DIR = dir;
    jest.isolateModules(() => { store = require('./encrypted-store'); });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (prevDataDir === undefined) delete process.env.RELAY_DATA_DIR;
    else process.env.RELAY_DATA_DIR = prevDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a snapshot replaces the entries it covers and keeps the ones it did not', () => {
    const seqs = [1, 2, 3].map((n) => store.addUpdate('fam', 'list', payload(n)).seq);
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);
    // The sender had applied the first two; the third raced its snapshot.
    store.addUpdate('fam', 'list', payload('snap'), { snapshot: true, coversSeq: seqs[1] });
    const kept = store.getUpdates('fam', 'list');
    expect(kept.map((u) => u.ciphertext)).toEqual(['c3', 'csnap']);
    expect(kept[1].snapshot).toBe(true);
    expect(kept[1].seq).toBeGreaterThan(seqs[2]);
  });

  test('retention never ages out a list\'s latest snapshot', () => {
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    store.addUpdate('fam', 'quiet', payload('old'));
    store.addUpdate('fam', 'quiet', payload('snap'), { snapshot: true, coversSeq: 0 });
    store.addUpdate('fam', 'gone', payload('never-snapshotted'));

    clock.mockReturnValue(t0 + 31 * DAY);
    store.cleanupExpiredUpdates(30 * DAY);

    expect(store.getUpdates('fam', 'quiet').map((u) => u.ciphertext)).toEqual(['csnap']);
    expect(store.getUpdates('fam', 'gone')).toEqual([]);
  });
});

describe('relay replay', () => {
  const PORT = 19959;
  let child;
  let directory;
  const sockets = [];

  async function until(predicate, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('condition not met in time');
  }

  async function connect(token) {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    sockets.push(socket);
    const frames = [];
    socket.on('message', (raw) => frames.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', relayToken: token }));
    await until(() => frames.some((f) => f.type === 'auth_ack'));
    socket.send(JSON.stringify({ type: 'identity', familyId: 'family', deviceId: token }));
    return { socket, frames };
  }

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantryrun-snapshot-test-'));
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
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('test relay did not start');
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

  test('history carries seq and ends with history_complete; a snapshot compacts what it covers', async () => {
    const a = await connect('a');
    await until(() => a.frames.some((f) => f.type === 'history_complete'));
    for (let i = 0; i < 3; i++) {
      a.socket.send(JSON.stringify({ type: 'update', familyId: 'family', deviceId: 'a', listId: 'list', payload: payload(i), msgId: `m${i}` }));
    }
    await until(() => a.frames.filter((f) => f.type === 'ack' && f.msgId).length === 3);

    const b = await connect('b');
    await until(() => b.frames.some((f) => f.type === 'history_complete'));
    const replay = b.frames.filter((f) => f.type === 'update');
    expect(replay.map((f) => f.payload.ciphertext)).toEqual(['c0', 'c1', 'c2']);
    expect(replay.every((f) => typeof f.seq === 'number')).toBe(true);
    expect(b.frames.findIndex((f) => f.type === 'history_complete')).toBeGreaterThan(b.frames.indexOf(replay[2]));

    b.socket.send(JSON.stringify({ type: 'update', familyId: 'family', deviceId: 'b', listId: 'list', payload: payload('snap'),
      snapshot: true, coversSeq: replay[2].seq, msgId: 'snap' }));
    await until(() => b.frames.some((f) => f.msgId === 'snap'));
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'data', 'encrypted-updates.json'), 'utf-8'));
    expect(stored.family.list.map((u) => u.ciphertext)).toEqual(['csnap']);
    expect(stored.family.list[0].snapshot).toBe(true);
  });
});
