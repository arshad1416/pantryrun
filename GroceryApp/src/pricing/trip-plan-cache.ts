/**
 * Trip Plan Cache — in-memory LRU with 5-minute TTL.
 *
 * Caches computed TripPlan results keyed by a deterministic hash of
 * { maxStops, itemIds, storeIds, quantities, units, prices }. The prices
 * the plan was computed from are part of the key, so a changed price can
 * never return a stale plan.
 */

import type { TripPlan } from './trip-plan';
import type { PriceResult } from './types';

// ─── Cache Shape ────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  plan: TripPlan;
  timestamp: number;
}

const MAX_ENTRIES = 5;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache: CacheEntry[] = [];

// ─── Key Generation ─────────────────────────────────────────────────────────

export interface TripPlanCacheKey {
  maxStops: number;
  itemIds: string[];
  storeIds: string[];
  /** Quantity + unit per item ID — a changed quantity or unit is a different basket. */
  quantities: Record<string, string>;
  /** Every price the plan can use, as `store:item=price/package unit` */
  prices: string[];
}

/**
 * Build a deterministic cache key. Item and store IDs are sorted to ensure
 * identical inputs always produce the same key regardless of order.
 */
export function buildCacheKey(
  maxStops: number,
  items: { id: string; quantity: number; unit?: string; name?: string; notes?: string }[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
): TripPlanCacheKey {
  const storeIds = Object.keys(perStorePrices).sort();
  const itemIds = items.map((i) => i.id).sort();
  const prices: string[] = [];
  for (const sid of storeIds) {
    for (const id of itemIds) {
      const pr = perStorePrices[sid]?.[id];
      if (pr) {
        prices.push(
          `${sid}:${id}=${pr.price}/${pr.packageSize ?? ''}${pr.unit}` +
            `|${pr.validTo ?? ''}|${pr.matchedName ?? ''}|${pr.membership ?? ''}`,
        );
      }
    }
  }
  return {
    maxStops,
    itemIds,
    storeIds,
    // Name and notes decide holds, substitutes and variant rules.
    quantities: Object.fromEntries(
      items.map((i) => [i.id, `${i.quantity}${i.unit ?? ''}|${i.name ?? ''}|${i.notes ?? ''}`]),
    ),
    prices,
  };
}

function keyToString(key: TripPlanCacheKey): string {
  return JSON.stringify(key);
}

// ─── Cache Operations ───────────────────────────────────────────────────────

/**
 * Retrieve a cached plan if it exists and hasn't expired.
 */
export function getCachedPlan(key: TripPlanCacheKey): TripPlan | null {
  const str = keyToString(key);
  const idx = cache.findIndex((e) => e.key === str);
  if (idx === -1) return null;

  const entry = cache[idx]!;
  if (Date.now() - entry.timestamp > TTL_MS) {
    // Expired — remove
    cache.splice(idx, 1);
    return null;
  }

  // Move to front (most recently used)
  if (idx > 0) {
    cache.splice(idx, 1);
    cache.unshift(entry);
  }

  return entry.plan;
}

/**
 * Store a plan in the cache. Evicts the least recently used entry if full.
 */
export function setCachedPlan(key: TripPlanCacheKey, plan: TripPlan): void {
  const str = keyToString(key);

  // Remove existing entry for this key (if any)
  cache = cache.filter((e) => e.key !== str);

  // Prepend new entry
  cache.unshift({ key: str, plan, timestamp: Date.now() });

  // Evict oldest entries beyond capacity
  while (cache.length > MAX_ENTRIES) {
    cache.pop();
  }
}

/**
 * Invalidate the entire cache (e.g., when prices change).
 */
export function invalidateCache(): void {
  cache = [];
}
