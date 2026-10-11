/**
 * encrypted-store.js durability.
 *
 * The store is a single JSON file holding every family's encrypted history.
 * Two ways it used to lose all of it:
 *  - a file that failed to parse loaded as {}, and the next addUpdate wrote
 *    that empty object back over it;
 *  - writes went straight to the live file, so a crash or a full disk
 *    mid-write left it torn — which then hit the first bug on next boot.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const payload = (n) => ({ ciphertext: `c${n}`, iv: `i${n}`, tag: `t${n}` });
let dir;
let prevDataDir;

function loadStore() {
  let store;
  jest.isolateModules(() => {
    store = require('./encrypted-store');
  });
  return store;
}

const updatesFile = () => path.join(dir, 'data', 'encrypted-updates.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-store-test-'));
  prevDataDir = process.env.RELAY_DATA_DIR;
  process.env.RELAY_DATA_DIR = dir;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  if (prevDataDir === undefined) delete process.env.RELAY_DATA_DIR;
  else process.env.RELAY_DATA_DIR = prevDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('an unreadable store is never overwritten', () => {
  test('addUpdate refuses to write over a file that does not parse, and a copy is kept aside', () => {
    const store = loadStore();
    store.addUpdate('fam', 'list', payload(1));
    const good = fs.readFileSync(updatesFile(), 'utf-8');
    // Simulate on-disk damage (truncated by a crash, bit rot, a bad restore).
    const damaged = good.slice(0, Math.floor(good.length / 2));
    fs.writeFileSync(updatesFile(), damaged);

    const fresh = loadStore();
    expect(fresh.getAllUpdates('fam')).toEqual({});
    expect(() => fresh.addUpdate('fam', 'list', payload(2))).toThrow(/unreadable/);
    expect(fs.readFileSync(updatesFile(), 'utf-8')).toBe(damaged);

    const aside = fs.readdirSync(path.join(dir, 'data')).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'data', aside[0]), 'utf-8')).toBe(damaged);
    expect(console.error).toHaveBeenCalled();
  });

  test('writes resume once the file parses again', () => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(updatesFile(), '{ not json');
    const store = loadStore();
    expect(() => store.addUpdate('fam', 'list', payload(1))).toThrow();
    // Operator restores a backup.
    fs.writeFileSync(updatesFile(), JSON.stringify({ fam: { list: [{ ...payload(0), storedAt: Date.now() }] } }));
    store.addUpdate('fam', 'list', payload(1));
    expect(store.getUpdates('fam', 'list').map((u) => u.ciphertext)).toEqual(['c0', 'c1']);
  });
});

describe('writes are atomic', () => {
  test('a write that dies halfway leaves the previous complete file', () => {
    const store = loadStore();
    store.addUpdate('fam', 'list', payload(1));

    // Every way of writing bytes writes half of them and then fails, as a full
    // disk or a killed process would.
    const realWriteFileSync = fs.writeFileSync;
    const realWriteSync = fs.writeSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
      realWriteFileSync(file, String(data).slice(0, 10), ...rest);
      throw new Error('ENOSPC: no space left on device');
    });
    jest.spyOn(fs, 'writeSync').mockImplementation((fd, data) => {
      realWriteSync(fd, String(data).slice(0, 10));
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      store.addUpdate('fam', 'list', payload(2));
    } catch {
      // Failing loudly is fine; corrupting the file is not.
    }
    jest.restoreAllMocks();

    const reloaded = loadStore();
    expect(reloaded.getUpdates('fam', 'list').map((u) => u.ciphertext)).toEqual(['c1']);
    expect(() => reloaded.addUpdate('fam', 'list', payload(3))).not.toThrow();
  });
});

describe('relay-state.json', () => {
  test('an unreadable state file is kept aside before the relay starts fresh, and saves are atomic', async () => {
    const { spawn } = require('child_process');
    const PORT = 19979;
    const state = path.join(dir, 'relay-state.json');
    fs.writeFileSync(state, '{"enrolledDevices": {"tok');
    const child = spawn(process.execPath, ['-e', "const net=require('net');const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(port,...args){return listen.call(this,port,'127.0.0.1',...args)};require('./server.js')"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT), RELAY_PORT: String(PORT), POOL_PORT: String(PORT + 1), RELAY_DATA_DIR: dir, RELAY_STATE_FILE: state },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch {}
        if (!up) await new Promise((r) => setTimeout(r, 50));
      }
      expect({ up, output: up ? '' : output }).toEqual({ up: true, output: '' });
      const aside = fs.readdirSync(dir).filter((f) => f.startsWith('relay-state.json.corrupt-'));
      expect(aside).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe('{"enrolledDevices": {"tok');
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await exited;
    }
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
    // persistState and the shutdown flush both go through the temp+rename path.
    expect(src).not.toMatch(/writeFileSync\(STATE_FILE/);
    expect(src).toMatch(/renameSync\(tmp, STATE_FILE\)/);
  }, 20000);
});
