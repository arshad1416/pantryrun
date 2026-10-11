/**
 * Region resolution — maps a user's FSA to the nearest region the scraper
 * actually covers.
 *
 * The scrapers run per city (weekly_flipp_scrape.py: one FSA per census
 * metropolitan area, e.g. Toronto → M5V). A user in M4C would match nothing
 * with an exact prefix query, so the relay answers from the nearest scraped
 * FSA within MAX_DISTANCE_KM instead. Coverage is read from Turso (distinct
 * FSAs with current rows) and cached; it is never sent anywhere.
 *
 * FSA centroids: fsa-centroids.json, built from the GeoNames Canadian postal
 * code dataset (https://download.geonames.org/export/zip/CA.zip), licensed
 * CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
 */

const CENTROIDS = require('./fsa-centroids.json');

const MAX_DISTANCE_KM = 120;
const COVERAGE_TTL_MS = 60 * 60 * 1000;

// Which FSAs have current rows. A plain DISTINCT over substr(postal_code)
// scans the whole table (millions of rows in flipp_deals, billed per row by
// Turso). This walks the (postal_code, …) index instead: one seek per distinct
// postal code, plus one EXISTS probe for freshness, so the cost scales with
// the number of regions, not rows.
function coverageSql(table, freshness) {
  return `WITH RECURSIVE codes(pc) AS (
            SELECT min(postal_code) FROM ${table}
            UNION ALL
            SELECT (SELECT min(postal_code) FROM ${table} WHERE postal_code > pc)
              FROM codes WHERE pc IS NOT NULL
          )
          SELECT DISTINCT upper(substr(pc, 1, 3)) AS coverage_fsa FROM codes
          WHERE pc IS NOT NULL
            AND EXISTS (SELECT 1 FROM ${table} WHERE postal_code = pc AND ${freshness})`;
}

const COVERAGE_SQL = {
  deals: coverageSql('flipp_deals', "valid_to >= date('now', '-1 day')"),
  shelf: coverageSql('store_prices', "scraped_at > datetime('now', '-7 days')"),
};

const coverageCache = new Map(); // kind → { at, fsas: Set<string> }

function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Nearest covered FSA to `fsa`: itself when covered, else the closest
 * covered centroid within MAX_DISTANCE_KM, else null (no prices nearby).
 */
function nearestCovered(fsa, covered) {
  if (covered.has(fsa)) return fsa;
  const origin = CENTROIDS[fsa];
  if (!origin) return null;
  let best = null;
  let bestKm = MAX_DISTANCE_KM;
  for (const candidate of covered) {
    const point = CENTROIDS[candidate];
    if (!point) continue;
    const km = distanceKm(origin, point);
    if (km <= bestKm) {
      best = candidate;
      bestKm = km;
    }
  }
  return best;
}

/**
 * Covered FSAs for a feed, from Turso, cached for COVERAGE_TTL_MS.
 * Returns null when coverage can't be read — callers then fall back to the
 * requested FSA, exactly as before region resolution existed.
 */
async function coverage(kind, turso, now = Date.now()) {
  const hit = coverageCache.get(kind);
  if (hit && now - hit.at < COVERAGE_TTL_MS) return hit.fsas;
  try {
    const rows = await turso.query(COVERAGE_SQL[kind], []);
    const fsas = new Set(
      rows.map((r) => String(r.coverage_fsa || '').toUpperCase()).filter((f) => /^[A-Z]\d[A-Z]$/.test(f)),
    );
    coverageCache.set(kind, { at: now, fsas });
    return fsas;
  } catch (err) {
    console.warn(`[prices] coverage query failed for ${kind}: ${err.message}`);
    return hit ? hit.fsas : null;
  }
}

/** The FSA to query for a user's FSA. Falls back to the user's own FSA. */
async function resolveSourceFsa(kind, fsa, turso, now = Date.now()) {
  const covered = await coverage(kind, turso, now);
  if (!covered || covered.size === 0) return fsa;
  return nearestCovered(fsa, covered);
}

function _resetRegionState() {
  coverageCache.clear();
}

module.exports = {
  resolveSourceFsa,
  nearestCovered,
  distanceKm,
  COVERAGE_SQL,
  MAX_DISTANCE_KM,
  _resetRegionState,
};
