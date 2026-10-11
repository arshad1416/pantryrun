/**
 * The relay's fake pool prices (seed-pool.js) are development/test data.
 * A real relay must never serve them from the unauthenticated
 * GET /api/pool/prices: they are seeded only when POOL_SEED_TEST_DATA=1.
 *
 * Drives the real server.js as a child process, once per setting.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startRelay(extraEnv) {
  const port = await freePort();
  // Own data dir, so the relay's state/used-token files never touch the ones
  // the other suites share.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-seed-'));
  const env = { ...process.env, PORT: String(port), RELAY_PORT: String(port), POOL_PORT: String(port), RELAY_STATE_FILE: path.join(dataDir, 'relay-state.json'), RELAY_DATA_DIR: dataDir, ASSISTANT_INTEGRATION: 'false' };
  delete env.POOL_SEED_TEST_DATA; // only what the test asks for
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c.toString(); });
  child.stderr.on('data', (c) => { output += c.toString(); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`relay did not start:\n${output}`)), 8000);
    child.stdout.on('data', (c) => {
      if (c.toString().includes('Listening on port')) { clearTimeout(t); resolve(); }
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function poolPrices(base, storeId) {
  const res = await fetch(`${base}/api/pool/prices?storeId=${encodeURIComponent(storeId)}`);
  expect(res.status).toBe(200);
  return (await res.json()).prices;
}

describe('pool test-data seeding', () => {
  test('a normal start serves no fake pool prices', async () => {
    const relay = await startRelay({});
    try {
      expect(await poolPrices(relay.base, 'loblaws')).toEqual([]);
      expect(await poolPrices(relay.base, 'no_frills')).toEqual([]);
    } finally {
      await relay.stop();
    }
  }, 20000);

  test('POOL_SEED_TEST_DATA=1 seeds them for development and tests', async () => {
    const relay = await startRelay({ POOL_SEED_TEST_DATA: '1' });
    try {
      expect((await poolPrices(relay.base, 'loblaws')).length).toBeGreaterThan(0);
    } finally {
      await relay.stop();
    }
  }, 20000);
});
