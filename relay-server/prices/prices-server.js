/**
 * Prices Server — live prices from the operator's scraper, read via Turso.
 *
 * Routes (GET, device-authenticated exactly like /api/extract/flyer):
 *  - /api/prices/deals?fsa=L0R  current flyer deals (flipp_deals)
 *  - /api/prices/shelf?fsa=L0R  newest shelf price per product scraped in
 *                                the last 7 days (store_prices)
 *
 * Privacy: the request names a region (FSA), never an item. The app
 * downloads the region's offers and matches its list on the device.
 *
 * Fails closed: without TURSO_URL + TURSO_READ_TOKEN every request gets 503.
 * Rows are capped, cached per region for CACHE_TTL_MS, and limited per
 * device so the relay can't be used to drain the operator's Turso quota.
 * Only allowlisted columns are returned.
 */

const turso = require('./turso-reader');
const region = require('./region');

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_ROWS = 5000;
const RATE_LIMIT_PER_MIN = 30;
const FSA_RE = /^[A-Z]\d[A-Z]$/;

/** Columns the app may see, per table. Anything else the scraper adds stays put. */
const DEAL_COLUMNS = ['merchant', 'name', 'price', 'price_real', 'image_url', 'valid_from', 'valid_to'];
const SHELF_COLUMNS = [
  'store_id', 'store_name', 'name', 'name_clean', 'price', 'price_real',
  'unit_price', 'unit_price_real', 'unit', 'image_url', 'brand', 'category',
  'is_on_sale', 'sale_price', 'was_price', 'scraped_at',
];

/**
 * SQL per feed. Both queries:
 *  - de-duplicate first: one shelf row per (store, product) — the newest
 *    scrape, since the 7-day window holds several and the FSA spans several
 *    postal codes; flyer rows repeated across the FSA's postal codes collapse
 *    to one (distinct flyer windows are kept: the app judges which applies);
 *  - then interleave stores (rank 1 of every store, then rank 2, …), so the
 *    row cap trims every store evenly instead of dropping whichever stores
 *    sort last alphabetically.
 * `limit` is one more than the cap so a cut answer can say `truncated`.
 *
 * `postal_code LIKE 'M5V%'` only uses an index declared on
 * `postal_code COLLATE NOCASE` (the one on flipp_deals is); against a plain
 * index it scans the table.
 */
function sqlFor(kind, limit) {
  if (kind === 'deals') {
    // valid_to is compared as a string against a bare date: Flipp writes ISO
    // strings with an offset, which don't order against SQLite's datetime(), but
    // "2026-10-10T…" >= "2026-10-10" holds exactly when its date part does, and
    // the bare comparison can use the (postal_code, valid_to) index. The app
    // judges the exact window; this only drops offers that ended before yesterday.
    return `SELECT * FROM (
              SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY merchant ORDER BY price_real IS NULL, price_real, name
                     ) AS store_rank
              FROM (
                SELECT *, ROW_NUMBER() OVER (
                         PARTITION BY merchant, name, price, valid_from, valid_to ORDER BY postal_code
                       ) AS listing_rank
                FROM flipp_deals
                WHERE postal_code LIKE ?
                  AND valid_to >= date('now', '-1 day')
              )
              WHERE listing_rank = 1
            )
            ORDER BY store_rank, merchant
            LIMIT ${limit}`;
  }
  return `SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (
                     PARTITION BY store_id ORDER BY scraped_at DESC, name_clean
                   ) AS store_rank
            FROM (
              SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY store_id, lower(coalesce(name_clean, name)) ORDER BY scraped_at DESC
                     ) AS product_rank
              FROM store_prices
              WHERE postal_code LIKE ?
                AND scraped_at > datetime('now', '-7 days')
            )
            WHERE product_rank = 1
          )
          ORDER BY store_rank, store_id
          LIMIT ${limit}`;
}

const QUERIES = {
  deals: { sql: sqlFor('deals', MAX_ROWS + 1), columns: DEAL_COLUMNS },
  shelf: { sql: sqlFor('shelf', MAX_ROWS + 1), columns: SHELF_COLUMNS },
};

const cache = new Map(); // `${kind}:${fsa}` → { at, payload }
const rateBuckets = new Map(); // relayToken → { windowStart, count }

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function pick(row, columns) {
  const out = {};
  for (const c of columns) if (c in row) out[c] = row[c];
  return out;
}

function withinRateLimit(relayToken, now) {
  const bucket = rateBuckets.get(relayToken);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    rateBuckets.set(relayToken, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_PER_MIN;
}

/** Same Bearer relayToken check as extract-server. Returns the token or null (response sent). */
function authenticate(req, res, enrolledDevices) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    send(res, 401, { error: 'Missing or invalid Authorization header. Expected: Bearer <relayToken>' });
    return null;
  }
  const relayToken = header.slice('Bearer '.length).trim();
  const enrollment = enrolledDevices.get(relayToken);
  if (!enrollment) {
    send(res, 403, { error: 'Invalid relay token' });
    return null;
  }
  if (Date.now() > enrollment.expiresAt) {
    enrolledDevices.delete(relayToken);
    send(res, 403, { error: 'Relay token has expired' });
    return null;
  }
  return relayToken;
}

/**
 * Handle /api/prices/* — returns false only for URLs outside /api/prices/;
 * every /api/prices/ URL gets a response (unknown kinds: 404).
 * @param {Map<string, object>} enrolledDevices relayToken → enrollment
 */
async function handlePricesRequest(req, res, enrolledDevices, now = Date.now()) {
  const url = new URL(req.url, 'http://relay.local');
  if (!url.pathname.startsWith('/api/prices/')) return false;
  const match = url.pathname.match(/^\/api\/prices\/(deals|shelf)$/);
  if (!match) {
    send(res, 404, { error: 'Unknown prices route. Use /api/prices/deals or /api/prices/shelf' });
    return true;
  }
  const kind = match[1];

  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    return true;
  }

  const relayToken = authenticate(req, res, enrolledDevices);
  if (!relayToken) return true;

  if (!turso.isConfigured()) {
    send(res, 503, { error: 'Live prices are not configured on this relay' });
    return true;
  }

  const fsa = (url.searchParams.get('fsa') || '').trim().toUpperCase();
  if (!FSA_RE.test(fsa)) {
    send(res, 400, { error: 'fsa must be the first three characters of a Canadian postal code, e.g. L0R' });
    return true;
  }

  if (!withinRateLimit(relayToken, now)) {
    send(res, 429, { error: `Rate limit exceeded. Max ${RATE_LIMIT_PER_MIN} price requests per minute.` }, { 'Retry-After': '60' });
    return true;
  }

  // Scrapes cover one FSA per city; answer from the nearest covered one.
  const sourceFsa = await region.resolveSourceFsa(kind, fsa, turso, now);
  if (!sourceFsa) {
    send(res, 200, {
      kind, fsa, sourceFsa: null, fetchedAt: new Date(now).toISOString(), truncated: false, rows: [],
    }, { 'Cache-Control': 'private, max-age=300' });
    return true;
  }

  const key = `${kind}:${sourceFsa}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    send(res, 200, { ...hit.payload, fsa }, { 'Cache-Control': 'private, max-age=300' });
    return true;
  }

  const { sql, columns } = QUERIES[kind];
  let rows;
  try {
    rows = await turso.query(sql, [`${sourceFsa}%`]);
  } catch (err) {
    // TursoError messages are safe (no URL, no token).
    console.warn(`[prices] ${kind} query failed for ${fsa}: ${err.message}`);
    if (hit) {
      // Serve the last good answer, saying so.
      send(res, 200, { ...hit.payload, fsa, stale: true }, { 'Cache-Control': 'no-store' });
    } else {
      send(res, 502, { error: 'Price source unavailable' });
    }
    return true;
  }

  const truncated = rows.length > MAX_ROWS;
  const payload = {
    kind,
    fsa,
    sourceFsa,
    fetchedAt: new Date(now).toISOString(),
    truncated,
    rows: rows.slice(0, MAX_ROWS).map((r) => pick(r, columns)),
  };
  cache.set(key, { at: now, payload });
  send(res, 200, payload, { 'Cache-Control': 'private, max-age=300' });
  return true;
}

/** Drop expired cache entries and rate buckets (called periodically). */
function cleanPricesState(now = Date.now()) {
  for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  for (const [k, v] of rateBuckets) if (now - v.windowStart >= 60_000) rateBuckets.delete(k);
}

/** Test hook. */
function _resetPricesState() {
  cache.clear();
  rateBuckets.clear();
  region._resetRegionState();
}

module.exports = {
  handlePricesRequest,
  cleanPricesState,
  _resetPricesState,
  sqlFor,
  CACHE_TTL_MS,
  MAX_ROWS,
  RATE_LIMIT_PER_MIN,
};
