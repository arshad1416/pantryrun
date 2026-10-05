/**
 * Turso reader — server-side, read-only access to the scraper's database.
 *
 * The scraper (flippscrape.py → flipp_deals, store_prices_scrape.py →
 * store_prices) writes to Turso from the operator's machine. The app must
 * never hold a Turso credential (GOAL_PROMPT_NOTES "Option B"), so the relay
 * reads on its behalf with a READ-ONLY token from its own environment:
 *
 *   TURSO_URL         e.g. https://<db>-<org>.turso.io  (libsql:// accepted)
 *   TURSO_READ_TOKEN  `turso db tokens create <db> --read-only`
 *
 * Unset → `isConfigured()` is false and callers fail closed. The token is
 * only ever placed in the Authorization header: never logged, never echoed.
 *
 * Wire format: Turso's Hrana-over-HTTP v2 pipeline (`POST /v2/pipeline`),
 * typed arguments and typed result values. No dependency beyond Node's fetch.
 */

const REQUEST_TIMEOUT_MS = 10_000;

function config() {
  const rawUrl = process.env.TURSO_URL || '';
  const token = process.env.TURSO_READ_TOKEN || '';
  if (!rawUrl || !token) return null;
  const url = rawUrl.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  return { url, token };
}

function isConfigured() {
  return config() !== null;
}

/** JS value → Hrana typed argument */
function toArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

/** Hrana typed value → JS value */
function fromValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  if (v.type === 'text') return v.value;
  return null; // blobs aren't used by the price tables
}

class TursoError extends Error {}

/**
 * Run one read query. Returns rows as plain objects keyed by column name.
 * Throws TursoError with a message safe to log (no URL, no token).
 */
async function query(sql, args = []) {
  const cfg = config();
  if (!cfg) throw new TursoError('Turso is not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.url}/v2/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql, args: args.map(toArg) } },
          { type: 'close' },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new TursoError(err && err.name === 'AbortError' ? 'Turso request timed out' : 'Turso request failed');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new TursoError(`Turso responded ${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new TursoError('Turso returned invalid JSON');
  }
  const first = body && Array.isArray(body.results) ? body.results[0] : null;
  if (!first || first.type !== 'ok') throw new TursoError('Turso query failed');

  const result = first.response && first.response.result;
  const cols = (result && result.cols ? result.cols : []).map((c) => c.name);
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  return rows.map((row) => {
    const obj = {};
    cols.forEach((name, i) => {
      obj[name] = fromValue(row[i]);
    });
    return obj;
  });
}

module.exports = { isConfigured, query, TursoError };
