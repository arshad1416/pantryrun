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
    // Region resolution has its own suite below; here the requested FSA is the source.
    jest.doMock('./region', () => ({
      resolveSourceFsa: async (kind, fsa) => fsa,
      _resetRegionState: () => {},
    }));
    reader = require('./turso-reader');
    server = require('./prices-server');
    server._resetPricesState();
    enrolled = new Map([[TOKEN, { expiresAt: Date.now() + 60_000 }]]);
  });
  afterEach(() => {
    jest.dontMock('./turso-reader');
    jest.dontMock('./region');
  });

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
    expect(args).toEqual(['L0R', 'L0S']);
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

    // Region coverage lookups carry no user input; the data queries carry only the region.
    const dataCalls = tursoCalls.filter((c) => !c.body.requests[0].stmt.sql.includes('coverage_fsa'));
    expect(dataCalls).toHaveLength(2);
    for (const c of tursoCalls) {
      expect(c.url).toBe('/v2/pipeline');
      expect(c.auth).toBe(`Bearer ${READ_TOKEN}`);
    }
    for (const c of dataCalls) {
      expect(c.url).toBe('/v2/pipeline');
      expect(c.auth).toBe(`Bearer ${READ_TOKEN}`);
      expect(c.body.requests[0].stmt.args).toEqual([{ type: 'text', value: 'L0R' }, { type: 'text', value: 'L0S' }]);
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

// ─── 4. The SQL itself, against a real SQLite ───────────────────────────────

let sqlite = null;
try {
  // Node ≥ 22.5. Older runtimes skip these (the handler tests above still run).
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

(sqlite ? describe : describe.skip)('price queries (SQLite)', () => {
  const { sqlFor, fsaRange, MAX_ROWS } = jest.requireActual('./prices-server');
  let db;

  beforeEach(() => {
    db = new sqlite.DatabaseSync(':memory:');
    db.exec(`CREATE TABLE store_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, store_name TEXT NOT NULL,
      name TEXT NOT NULL, name_clean TEXT NOT NULL, price TEXT NOT NULL, price_real REAL,
      unit_price TEXT, unit_price_real REAL, unit TEXT, image_url TEXT, brand TEXT, category TEXT,
      is_on_sale INTEGER DEFAULT 0, sale_price REAL, was_price REAL, postal_code TEXT NOT NULL,
      scraped_at TEXT NOT NULL DEFAULT (datetime('now')), source TEXT NOT NULL DEFAULT 'scraper',
      UNIQUE(store_id, name_clean, postal_code))`);
    db.exec(`CREATE TABLE flipp_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, flyer_id INTEGER, merchant TEXT, postal_code TEXT,
      name TEXT, price TEXT, price_real REAL, brand TEXT, image_url TEXT, valid_from TEXT, valid_to TEXT)`);
  });

  function addShelf(store, name, price, daysAgo, postal = 'L0R2H4') {
    db.prepare(`INSERT INTO store_prices (store_id, store_name, name, name_clean, price, price_real, postal_code, scraped_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`)
      .run(store, store, name, name.toLowerCase(), String(price), price, postal, `-${daysAgo} days`);
  }

  function addDeal(merchant, name, price, postal = 'L0R2H4') {
    db.prepare(`INSERT INTO flipp_deals (merchant, postal_code, name, price, price_real, valid_from, valid_to)
                VALUES (?, ?, ?, ?, ?, date('now'), date('now', '+5 days'))`).run(merchant, postal, name, String(price), price);
  }

  test('shelf: newest scrape per product across postal codes; older cheaper rows dropped', () => {
    addShelf('nofrills', 'Milk 4 L', 4.49, 5, 'L0R1A1'); // older, cheaper, another postal code
    addShelf('nofrills', 'Milk 4 L', 5.99, 1, 'L0R2H4');
    addShelf('nofrills', 'Bread', 2.99, 2);
    const rows = db.prepare(sqlFor('shelf', MAX_ROWS + 1)).all('L0R', 'L0S');
    expect(rows.map((r) => [r.name, r.price_real])).toEqual(expect.arrayContaining([['Milk 4 L', 5.99], ['Bread', 2.99]]));
    expect(rows).toHaveLength(2);
  });

  test('shelf: the cap trims every store evenly, not alphabetically-late stores', () => {
    for (let i = 0; i < 5; i++) {
      addShelf('loblaws', `Item ${i}`, 1 + i, 1);
      addShelf('superstore', `Item ${i}`, 1 + i, 1);
    }
    const rows = db.prepare(sqlFor('shelf', 6)).all('L0R', 'L0S');
    const perStore = rows.reduce((m, r) => ({ ...m, [r.store_id]: (m[r.store_id] || 0) + 1 }), {});
    expect(perStore).toEqual({ loblaws: 3, superstore: 3 });
  });

  test('deals: duplicates across postal codes collapse; merchants interleave under the cap', () => {
    addDeal('Food Basics', 'Grapes', 2.99, 'L0R1A1');
    addDeal('Food Basics', 'Grapes', 2.99, 'L0R2H4');
    for (let i = 0; i < 5; i++) {
      addDeal('Food Basics', `Deal ${i}`, 1 + i);
      addDeal('Zehrs', `Deal ${i}`, 1 + i);
    }
    const all = db.prepare(sqlFor('deals', MAX_ROWS + 1)).all('L0R', 'L0S');
    expect(all.filter((r) => r.name === 'Grapes')).toHaveLength(1);
    const capped = db.prepare(sqlFor('deals', 6)).all('L0R', 'L0S');
    expect(capped.filter((r) => r.merchant === 'Zehrs')).toHaveLength(3);
  });

  test('range bounds keep neighbouring FSAs out', () => {
    addShelf('nofrills', 'Milk 4 L', 5.99, 1, 'L0R2H4');
    addShelf('nofrills', 'Eggs', 3.99, 1, 'L0S1A1');
    addShelf('nofrills', 'Rice', 9.99, 1, 'L0Q9Z9');
    const rows = db.prepare(sqlFor('shelf', MAX_ROWS + 1)).all(...fsaRange('L0R'));
    expect(rows.map((r) => r.name)).toEqual(['Milk 4 L']);
    expect(fsaRange('M5V')).toEqual(['M5V', 'M5W']);
  });

  test('coverage lists FSAs with current rows only, and the data queries use the index', () => {
    const { COVERAGE_SQL } = require('./region');
    db.exec('CREATE INDEX deals_pc ON flipp_deals(postal_code, valid_to)');
    db.exec('CREATE INDEX shelf_pc ON store_prices(postal_code, scraped_at)');
    addDeal('Zehrs', 'Grapes', 2.99, 'L0R2H4');
    addDeal('Zehrs', 'Grapes', 2.99, 'M5V3L9');
    db.prepare(`INSERT INTO flipp_deals (merchant, postal_code, name, price, price_real, valid_from, valid_to)
                VALUES ('Old', 'K1P1J1', 'Stale', '1', 1, '2020-01-01', '2020-01-07T23:59:59-05:00')`).run();
    addShelf('nofrills', 'Milk 4 L', 5.99, 1, 'H2X1Y4');
    addShelf('nofrills', 'Milk 4 L', 5.99, 30, 'V6B1A1');
    const fsas = (sql) => db.prepare(sql).all().map((r) => r.coverage_fsa).sort();
    expect(fsas(COVERAGE_SQL.deals)).toEqual(['L0R', 'M5V']);
    expect(fsas(COVERAGE_SQL.shelf)).toEqual(['H2X']);
    for (const kind of ['deals', 'shelf']) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sqlFor(kind, 10)}`).all('L0R', 'L0S').map((r) => r.detail).join('\n');
      expect(plan).toMatch(/USING (COVERING )?INDEX/);
    }
  });
});

describe('truncation flag', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => jest.dontMock('./turso-reader'));

  test('a capped answer says truncated and carries exactly MAX_ROWS rows', async () => {
    const big = (n) => Array.from({ length: n }, (_, i) => ({ ...SHELF_ROWS[0], name: `Item ${i}` }));
    let rowsToReturn = big(10);
    jest.doMock('./turso-reader', () => ({ isConfigured: () => true, query: async () => rowsToReturn, TursoError: Error }));
    const server = require('./prices-server');
    server._resetPricesState();
    const enrolled = new Map([['t', { expiresAt: Date.now() + 60_000 }]]);
    const ask = async () => {
      server._resetPricesState();
      const res = mockRes();
      await server.handlePricesRequest(mockReq('/api/prices/shelf?fsa=L0R', { token: 't' }), res, enrolled);
      return res.body;
    };

    expect((await ask()).truncated).toBe(false);

    rowsToReturn = big(server.MAX_ROWS + 1);
    const cut = await ask();
    expect(cut.truncated).toBe(true);
    expect(cut.rows).toHaveLength(server.MAX_ROWS);

    // Exactly MAX_ROWS rows is a complete answer, not a truncated one.
    rowsToReturn = big(server.MAX_ROWS);
    expect((await ask()).truncated).toBe(false);
  });
});

// ─── 4. region resolution ───────────────────────────────────────────────────

describe('region resolution', () => {
  const region = require('./region');

  test('a covered FSA answers from itself', () => {
    expect(region.nearestCovered('M5V', new Set(['M5V', 'L8P']))).toBe('M5V');
  });

  test('an uncovered Toronto FSA answers from the nearest scraped city FSA', () => {
    expect(region.nearestCovered('M4C', new Set(['M5V', 'L8P', 'K1P']))).toBe('M5V');
    expect(region.nearestCovered('L8B', new Set(['M5V', 'L8P', 'K1P']))).toBe('L8P');
  });

  test('nothing within range means no prices rather than a far-away city', () => {
    // Thunder Bay is far beyond MAX_DISTANCE_KM of Toronto.
    expect(region.nearestCovered('P7B', new Set(['M5V']))).toBeNull();
    expect(region.nearestCovered('Z9Z', new Set(['M5V']))).toBeNull();
  });

  describe('handler', () => {
    let server;
    let query;
    beforeEach(() => {
      jest.resetModules();
      query = jest.fn(async (sql, args) => {
        if (sql.includes('coverage_fsa')) return [{ coverage_fsa: 'M5V' }, { coverage_fsa: 'K1P' }];
        return args[0] === 'M5V' ? SHELF_ROWS : [];
      });
      jest.doMock('./turso-reader', () => ({ isConfigured: () => true, query, TursoError: Error }));
      server = require('./prices-server');
      server._resetPricesState();
    });
    afterEach(() => jest.dontMock('./turso-reader'));

    const enrolled = new Map([['t', { expiresAt: Date.now() + 3_600_000 }]]);
    async function ask(fsa) {
      const res = mockRes();
      await server.handlePricesRequest(mockReq(`/api/prices/shelf?fsa=${fsa}`, { token: 't' }), res, enrolled);
      return res.body;
    }

    test('queries the nearest covered FSA and says which it used', async () => {
      const body = await ask('M4C');
      expect(body.fsa).toBe('M4C');
      expect(body.sourceFsa).toBe('M5V');
      expect(body.rows.length).toBeGreaterThan(0);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM store_prices'), ['M5V', 'M5W']);
    });

    test('neighbours share one cached answer and one coverage read', async () => {
      await ask('M4C');
      const second = await ask('M6K');
      expect(second.fsa).toBe('M6K');
      expect(second.sourceFsa).toBe('M5V');
      expect(query.mock.calls.filter(([sql]) => sql.includes('coverage_fsa'))).toHaveLength(1);
      expect(query.mock.calls.filter(([sql]) => !sql.includes('coverage_fsa'))).toHaveLength(1);
    });

    test('out of range: empty rows and a null sourceFsa, without a data query', async () => {
      const body = await ask('V6B');
      expect(body.sourceFsa).toBeNull();
      expect(body.rows).toEqual([]);
      expect(query.mock.calls.filter(([sql]) => !sql.includes('coverage_fsa'))).toHaveLength(0);
    });
  });
});
