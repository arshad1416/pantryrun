/**
 * Pool Server — In-Memory Aggregation Store.
 *
 * Key format: storeId:normalizedName:flyerWeek
 * Stores prices without contributor info, IP, or fine timestamps.
 *
 * Store ids carry a colon themselves ("no-frills:M5V" — chain:region, see the
 * app's contribute.ts), and item names may too, so the key is never split
 * back apart: each entry keeps its storeId / itemName / flyerWeek as given to
 * addReport. Keys added without them (legacy seed data) fall back to the
 * last segment as flyerWeek and the longest storeId prefix.
 *
 * Methods:
 *  - addReport(key, price) — stores a price report
 *  - getAggregates(storeId) — returns aggregated prices for a store
 *  - getExpired() — returns keys where validTo < now
 *  - seed(data) — bulk insert for test seeding
 *  - getAll() — debug/seed inspection
 */

const { aggregatePriceReports } = require('./aggregator');

class PoolStore {
  constructor() {
    /** @type {Map<string, { reports: Array<{ price: number, addedAt: number }>, validTo: number, meta: { storeId: string, itemName: string, flyerWeek: string } | null }>} */
    this._store = new Map();
  }

  /**
   * Build the store key from storeId, normalizedName, and flyerWeek.
   * @param {string} storeId
   * @param {string} normalizedName
   * @param {string} flyerWeek
   * @returns {string}
   */
  _makeKey(storeId, normalizedName, flyerWeek) {
    return `${storeId}:${normalizedName}:${flyerWeek}`;
  }

  /**
   * Add a price report for a given key.
   * No contributor info, no IP, no fine timestamp stored.
   *
   * @param {string} key - storeId:normalizedName:flyerWeek
   * @param {number} price
   * @param {number} validTo - epoch ms when this report expires
   * @param {{ storeId: string, itemName: string, flyerWeek: string }} [meta] -
   *   the key's parts, kept so getAggregates never has to split the key
   */
  addReport(key, price, validTo, meta) {
    if (!this._store.has(key)) {
      this._store.set(key, { reports: [], validTo, meta: meta || null });
    }
    const entry = this._store.get(key);
    if (meta && !entry.meta) entry.meta = meta;
    // Purge reports older than 90 days from this entry before appending
    const expiredThreshold = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90-day window
    entry.reports = entry.reports.filter(r => r.addedAt > expiredThreshold);
    // Cap at 500 reports per key (prevents unbounded growth)
    if (entry.reports.length >= 500) {
      entry.reports.shift(); // drop oldest
    }
    entry.reports.push({ price, addedAt: Date.now() });
    // Use the latest validTo
    if (validTo > entry.validTo) {
      entry.validTo = validTo;
    }
  }

  /**
   * Get aggregated prices for a store.
   * Filters out expired entries, aggregates remaining ones.
   *
   * @param {string} storeId
   * @returns {Array<{ itemName: string, flyerWeek: string, median: number|null, count: number, stdev: number|null, validTo: number }>}
   */
  getAggregates(storeId) {
    const now = Date.now();
    const results = [];

    for (const [key, entry] of this._store) {
      if (entry.validTo <= now) continue; // expired

      const parts = entry.meta || this._parseLegacyKey(key, storeId);
      if (!parts || parts.storeId !== storeId) continue;

      const normalizedName = parts.itemName;
      const flyerWeek = parts.flyerWeek;
      const agg = aggregatePriceReports(entry.reports.map(r => r.price));

      results.push({
        itemName: normalizedName,
        flyerWeek,
        median: agg.median,
        count: agg.count,
        stdev: agg.stdev,
        validTo: entry.validTo,
      });
    }

    return results;
  }

  /**
   * Parts of a key stored without metadata, for the store asked about:
   * `${storeId}:${itemName}:${flyerWeek}` with flyerWeek the last segment.
   * null when the key isn't that store's.
   * @param {string} key
   * @param {string} storeId
   * @returns {{ storeId: string, itemName: string, flyerWeek: string } | null}
   */
  _parseLegacyKey(key, storeId) {
    const weekAt = key.lastIndexOf(':');
    if (weekAt < 0 || !key.startsWith(`${storeId}:`)) return null;
    const itemName = key.slice(storeId.length + 1, weekAt);
    if (!itemName) return null;
    return { storeId, itemName, flyerWeek: key.slice(weekAt + 1) };
  }

  /**
   * Get keys of expired entries.
   * @returns {string[]}
   */
  getExpired() {
    const now = Date.now();
    const expired = [];
    for (const [key, entry] of this._store) {
      if (entry.validTo <= now) {
        expired.push(key);
      }
    }
    return expired;
  }

  /**
   * Seed data for testing. Accepts array of { key, price, validTo } objects.
   * @param {Array<{ key: string, price: number, validTo: number }>} data
   */
  seed(data) {
    for (const item of data) {
      this.addReport(item.key, item.price, item.validTo);
    }
  }

  /**
   * Get all entries (debug/inspection).
   * @returns {Array<{ key: string, prices: number[], validTo: number }>}
   */
  getAll() {
    const entries = [];
    for (const [key, entry] of this._store) {
      entries.push({ key, prices: entry.reports.map(r => r.price), validTo: entry.validTo });
    }
    return entries;
  }
}

module.exports = { PoolStore };
