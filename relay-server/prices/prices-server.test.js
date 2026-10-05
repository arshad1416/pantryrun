/**
 * Live prices — turso-reader + /api/prices/{deals,shelf}.
 *
 *  1. turso-reader: Hrana v2 request shape, typed values, fail-closed config,
 *     errors that never carry the token.
 *  2. prices-server (handler, reader stubbed): auth, 503 without config,
 *     FSA validation, parameterised query, column allowlist, cache, rate
 *     limit, stale fallback.
 *  3. End to end: the real relay (child process) against a fake Turso HTTP
 *     server, with a device enrolled the normal way.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const nacl = require('tweetnacl');

const READ_TOKEN = 'test-read-token-must-never-leak';

// ─── helpers ────────────────────────────────────────────────────────────────

function hranaResult(rows) {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  const typed = (v) =>
    v === null ? { type: 'null' }
      : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
        : { type: 'text', value: String(v) };
  return {
    results: [
      {
        type: 'ok',
        response: {
          type: 'execute',
          result: { cols: cols.map((name) => ({ name })), rows: rows.map((r) => cols.map((c) => typed(r[c]))) },
        },
      },
      { type: 'ok', response: { type: 'close' } },
    ],
  };
}

function mockReq(url, { method = 'GET', token } = {}) {
  return { url, method, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function mockRes() {
  const res = { status: null, headers: {}, body: null };
  res.writeHead = (status, headers = {}) => { res.status = status; Object.assign(res.headers, headers); };
  res.end = (body) => { res.body = body ? JSON.parse(body) : null; };
  return res;
}

const DEAL_ROWS = [
  { merchant: 'No Frills', name: 'Green Seedless Grapes', price: '2.99', price_real: 2.99, image_url: null, valid_from: '2026-10-02', valid_to: '2026-10-08T23:59:59-04:00', postal_code: 'L0R2H4', flyer_internal_id: 9876 },
];
const SHELF_ROWS = [
  { store_id: 'nofrills', store_name: 'No Frills', name: 'Lactantia Lactose Free 2% Milk 2 L', name_clean: 'lactantia lactose free 2 milk 2 l', price: '6.49', price_real: 6.49, unit_price: '$3.25/1l', unit_price_real: 3.245, unit: '2 l', image_url: null, brand: 'Lactantia', category: 'dairy', is_on_sale: 0, sale_price: null, was_price: null, postal_code: 'L0R2H4', scraped_at: '2026-10-04 06:00:00', source: 'scraper' },
];

// ─── 1. turso-reader ────────────────────────────────────────────────────────

describe('turso-reader', () => {
  const realFetch = global.fetch;
  let reader;

  beforeEach(() => {
    jest.resetModules();
    process.env.TURSO_URL = 'libsql://pantry-test.turso.io';
    process.env.TURSO_READ_TOKEN = READ_TOKEN;
    reader = require('./turso-reader');
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.TURSO_URL;
    delete process.env.TURSO_READ_TOKEN;
  });

  test('is not configured without both env vars', () => {
    delete process.env.TURSO_READ_TOKEN;
    expect(reader.isConfigured()).toBe(false);
  });

  test('sends a Hrana v2 pipeline with typed args and decodes typed values', async () => {
    let sent;
    global.fetch = jest.fn(async (url, init) => {
      sent = { url, init };
      return { ok: true, json: async () => hranaResult([{ a: 'x', n: 3, f: 2.5, z: null }]) };
    });
    const rows = await reader.query('SELECT * FROM t WHERE p LIKE ? AND n > ?', ['L0R%', 2]);
    expect(rows).toEqual([{ a: 'x', n: 3, f: 2.5, z: null }]);
    expect(sent.url).toBe('https://pantry-test.turso.io/v2/pipeline');
    expect(sent.init.headers.Authorization).toBe(`Bearer ${READ_TOKEN}`);
    const body = JSON.parse(sent.init.body);
    expect(body.requests[0]).toEqual({
      type: 'execute',
      stmt: { sql: 'SELECT * FROM t WHERE p LIKE ? AND n > ?', args: [{ type: 'text', value: 'L0R%' }, { type: 'integer', value: '2' }] },
    });
    expect(body.requests[1]).toEqual({ type: 'close' });
  });

  test('errors never include the token or URL', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(reader.query('SELECT 1')).rejects.toThrow('Turso responded 401');
    global.fetch = jest.fn(async () => { throw new Error(`connect ECONNREFUSED ${READ_TOKEN}`); });
    const err = await reader.query('SELECT 1').catch((e) => e);
    expect(err.message).not.toContain(READ_TOKEN);
    expect(err.message).not.toContain('turso.io');
  });

  test('a failed statement is an error, not empty rows', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ results: [{ type: 'error', error: { message: 'no such table' } }] }) }));
    await expect(reader.query('SELECT 1')).rejects.toThrow('Turso query failed');
  });
});

// ─── 2. handler ─────────────────────────────────────────────────────────────

describe('handlePricesRequest', () => {
  const TOKEN = 'relay-token-1';
  let server;
  let reader;
  let enrolled;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('./turso-reader', () => ({
      isConfigured: jest.fn(() => true),
      query: jest.fn(async (sql) => (sql.includes('flipp_deals') ? DEAL_ROWS : SHELF_ROWS)),
      TursoError: Error,
    }));
    reader = require('./turso-reader');
    server = require('./prices-server');
    server._resetPricesState();
    enrolled = new Map([[TOKEN, { expiresAt: Date.now() + 60_000 }]]);
  });
  afterEach(() => jest.dontMock('./turso-reader'));

  async function call(url, opts) {
    const res = mockRes();
    const handled = await server.handlePricesRequest(mockReq(url, opts), res, enrolled);
    return { handled, res };
  }

  test('ignores other routes', async () => {
    const { handled } = await call('/api/pool/prices', { token: TOKEN });
    expect(handled).toBe(false);
  });

  test('answers unknown /api/prices/ paths with 404 instead of leaving them hanging', async () => {
    const { handled, res } = await call('/api/prices/everything?fsa=L0R', { token: TOKEN });
    expect(handled).toBe(true);
    expect(res.status).toBe(404);
    expect(reader.query).not.toHaveBeenCalled();
  });

  test('requires a valid, unexpired device token', async () => {
    expect((await call('/api/prices/deals?fsa=L0R')).res.status).toBe(401);
    expect((await call('/api/prices/deals?fsa=L0R', { token: 'nope' })).res.status).toBe(403);
    enrolled.set('old', { expiresAt: Date.now() - 1 });
    expect((await call('/api/prices/deals?fsa=L0R', { token: 'old' })).res.status).toBe(403);
    expect(reader.query).not.toHaveBeenCalled();
  });

  test('fails closed with 503 when Turso is not configured', async () => {
    reader.isConfigured.mockReturnValue(false);
    const { res } = await call('/api/prices/deals?fsa=L0R', { token: TOKEN });
    expect(res.status).toBe(503);
    expect(reader.query).not.toHaveBeenCalled();
  });

  test.each(['', 'L0', 'L0R2H4', "L0R' OR 1=1--", '123', 'l0r%'])('rejects fsa %j', async (fsa) => {
    const { res } = await call(`/api/prices/deals?fsa=${encodeURIComponent(fsa)}`, { token: TOKEN });
    expect(res.status).toBe(400);
    expect(reader.query).not.toHaveBeenCalled();
  });

  test('only GET', async () => {
    expect((await call('/api/prices/deals?fsa=L0R', { token: TOKEN, method: 'POST' })).res.status).toBe(405);
  });

  test('deals: parameterised prefix query, allowlisted columns only', async () => {
    const { res } = await call('/api/prices/deals?fsa=l0r', { token: TOKEN });
    expect(res.status).toBe(200);
    const [sql, args] = reader.query.mock.calls[0];
    expect(sql).toContain('FROM flipp_deals');
    expect(sql).not.toContain('L0R');
    expect(args).toEqual(['L0R%']);
    expect(res.body.fsa).toBe('L0R');
    expect(res.body.rows).toEqual([
      { merchant: 'No Frills', name: 'Green Seedless Grapes', price: '2.99', price_real: 2.99, image_url: null, valid_from: '2026-10-02', valid_to: '2026-10-08T23:59:59-04:00' },
    ]);
  });

  test('shelf: 7-day window, no postal_code/source leaked', async () => {
    const { res } = await call('/api/prices/shelf?fsa=L0R', { token: TOKEN });
    const [sql] = reader.query.mock.calls[0];
    expect(sql).toContain('FROM store_prices');
    expect(sql).toContain("datetime('now', '-7 days')");
    expect(res.body.rows[0]).not.toHaveProperty('postal_code');
    expect(res.body.rows[0]).not.toHaveProperty('source');
    expect(res.body.rows[0].store_id).toBe('nofrills');
  });

  test('caches per region and kind', async () => {
    const now = Date.now();
    await server.handlePricesRequest(mockReq('/api/prices/deals?fsa=L0R', { token: TOKEN }), mockRes(), enrolled, now);
    await server.handlePricesRequest(mockReq('/api/prices/deals?fsa=L0R', { token: TOKEN }), mockRes(), enrolled, now + 60_000);
    expect(reader.query).toHaveBeenCalledTimes(1);
    await server.handlePricesRequest(mockReq('/api/prices/shelf?fsa=L0R', { token: TOKEN }), mockRes(), enrolled, now + 60_000);
    expect(reader.query).toHaveBeenCalledTimes(2);
    await server.handlePricesRequest(mockReq('/api/prices/deals?fsa=L0R', { token: TOKEN }), mockRes(), enrolled, now + server.CACHE_TTL_MS + 1);
    expect(reader.query).toHaveBeenCalledTimes(3);
  });

  test('rate-limits per device', async () => {
    const now = Date.now();
    let last;
    for (let i = 0; i <= server.RATE_LIMIT_PER_MIN; i++) {
      last = mockRes();
      await server.handlePricesRequest(mockReq('/api/prices/deals?fsa=L0R', { token: TOKEN }), last, enrolled, now);
    }
    expect(last.status).toBe(429);
  });

  test('source failure: 502 with nothing cached, last good answer marked stale otherwise', async () => {
    reader.query.mockRejectedValueOnce(new Error('Turso responded 500'));
    expect((await call('/api/prices/deals?fsa=L8B', { token: TOKEN })).res.status).toBe(502);

    const now = Date.now();
    await server.handlePricesRequest(mockReq('/api/prices/deals?fsa=L0R', { token: TOKEN }), mockRes(), enrolled, now);
    reader.query.mockRejectedValueOnce(new Error('Turso responded 500'));
    const res = mockRes();
    await server.handlePricesRequest(mockReq('/api/prices/deals?fsa=L0R', { token: TOKEN }), res, enrolled, now + server.CACHE_TTL_MS + 1);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.rows).toHaveLength(1);
  });
});

// ─── 3. end to end ──────────────────────────────────────────────────────────

/** A port nothing is listening on right now. */
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

describe('relay /api/prices end to end (fake Turso)', () => {
  let PORT;
  let BASE;
  const stateFile = path.join(__dirname, '..', '__prices_e2e_state__.json');
  let fakeTurso;
  let tursoCalls = [];
  let child;
  let output = '';

  beforeAll(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    const poolPort = await freePort();
    fakeTurso = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        tursoCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        const sql = JSON.parse(body).requests[0].stmt.sql;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hranaResult(sql.includes('flipp_deals') ? DEAL_ROWS : SHELF_ROWS)));
      });
    });
    await new Promise((r) => fakeTurso.listen(0, '127.0.0.1', r));
    const tursoUrl = `http://127.0.0.1:${fakeTurso.address().port}`;

    try { fs.unlinkSync(stateFile); } catch {}
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        RELAY_PORT: String(PORT),
        POOL_PORT: String(poolPort),
        RELAY_STATE_FILE: stateFile,
        RELAY_DATA_DIR: '',
        ASSISTANT_INTEGRATION: 'false',
        TURSO_URL: tursoUrl,
        TURSO_READ_TOKEN: READ_TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => { output += c.toString(); });
    child.stderr.on('data', (c) => { output += c.toString(); });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`relay did not start:\n${output}`)), 8000);
      child.stdout.on('data', (c) => {
        if (c.toString().includes('Listening on port')) { clearTimeout(t); resolve(); }
      });
    });
  }, 15000);

  afterAll(async () => {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
    await new Promise((r) => fakeTurso.close(r));
    try { fs.unlinkSync(stateFile); } catch {}
  });

  async function enrollDevice() {
    const kp = nacl.sign.keyPair();
    const familyId = `fam-${Date.now()}`;
    const deviceId = Buffer.from(kp.publicKey).toString('base64');
    const payload = JSON.stringify({ familyId, deviceId, expiresAt: Date.now() + 86_400_000, nonce: Buffer.from(nacl.randomBytes(16)).toString('base64') });
    const parsed = JSON.parse(payload);
    const sig = nacl.sign.detached(new TextEncoder().encode(payload), kp.secretKey);
    const invite = JSON.stringify({ ...parsed, signature: Buffer.from(sig).toString('base64') });
    const res = await fetch(`${BASE}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceToken: Buffer.from(nacl.randomBytes(32)).toString('base64'), familyInviteToken: invite }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    return body.relayToken;
  }

  test('an enrolled device gets deals and shelf prices; Turso sees only the read token and a region', async () => {
    const relayToken = await enrollDevice();
    expect(typeof relayToken).toBe('string');

    const deals = await fetch(`${BASE}/api/prices/deals?fsa=L0R`, { headers: { Authorization: `Bearer ${relayToken}` } });
    expect(deals.status).toBe(200);
    expect((await deals.json()).rows[0].name).toBe('Green Seedless Grapes');

    const shelf = await fetch(`${BASE}/api/prices/shelf?fsa=L0R`, { headers: { Authorization: `Bearer ${relayToken}` } });
    expect(shelf.status).toBe(200);
    expect((await shelf.json()).rows[0].store_name).toBe('No Frills');

    expect(tursoCalls).toHaveLength(2);
    for (const c of tursoCalls) {
      expect(c.url).toBe('/v2/pipeline');
      expect(c.auth).toBe(`Bearer ${READ_TOKEN}`);
      expect(c.body.requests[0].stmt.args).toEqual([{ type: 'text', value: 'L0R%' }]);
    }
  });

  test('unauthenticated requests never reach Turso', async () => {
    const before = tursoCalls.length;
    const res = await fetch(`${BASE}/api/prices/deals?fsa=L0R`);
    expect(res.status).toBe(401);
    expect(tursoCalls.length).toBe(before);
  });

  test('the read token never appears in relay output', () => {
    expect(output).not.toContain(READ_TOKEN);
  });
});
