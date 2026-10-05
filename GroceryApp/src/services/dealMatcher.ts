/**
 * DealMatcher — matches grocery list items against Flipp flyer deals
 * using in-memory caching and keyword-based token intersection.
 *
 * Deals come from the relay (GET /api/prices/deals, see
 * pricing/live-prices.ts), which reads the operator's flyer scraper:
 *   - Fetch all deals for the user's FSA (no item names leave the device)
 *   - Reuse the region's snapshot between refreshes
 *   - Search locally with token intersection matching
 *   - Greedy set-cover algorithm for store optimization
 */

import { extractKeywords, matchScore } from '../pricing/basket';
import { loadFlyerDeals, type FlyerDealRow } from '../pricing/live-prices';
import type { GroceryItem } from '../types';

/** A flyer deal row as served by the relay. */
export type FlippDealRow = FlyerDealRow;

export interface DealMatch {
  merchant: string;
  itemName: string;
  price: string;
  priceReal: number | null;
  validTo: string;
  imageUrl?: string;
}

export interface OptimizedStoreRun {
  /** Stores sorted by number of matching items (descending) */
  stores: {
    merchant: string;
    items: { listItemId: string; itemName: string; deal: DealMatch }[];
    itemCount: number;
    estimatedTotal: number;
  }[];
  /** Items that didn't match any deal */
  unmatched: { listItemId: string; itemName: string }[];
  totalStops: number;
}

// ─── Deal fetching ───────────────────────────────────────────────────────────

/**
 * All current deals for an FSA, from the relay. Empty when the relay isn't
 * configured or has no prices; last-known deals when a refresh fails.
 */
export async function fetchDealsForFSA(
  fsa: string,
  forceRefresh = false,
): Promise<FlippDealRow[]> {
  const snap = await loadFlyerDeals(fsa, forceRefresh);
  return snap?.rows ?? [];
}

// ─── Deal matching ───────────────────────────────────────────────────────────

/**
 * Search deals for a single grocery item name within a set of deals.
 * Returns matches sorted by confidence then price.
 */
function matchItemToDeals(
  itemName: string,
  deals: FlippDealRow[],
  threshold = 0.35,
): DealMatch[] {
  const queryTokens = extractKeywords(itemName);
  if (queryTokens.length === 0) return [];

  const scored: { deal: FlippDealRow; score: number }[] = [];
  const now = Date.now();

  for (const deal of deals) {
    // Cached deals outlive the SQL expiry filter — skip ended offers.
    const end = new Date(deal.valid_to).getTime();
    if (!isNaN(end) && end < now) continue;
    const dealTokens = extractKeywords(deal.name);
    const score = matchScore(queryTokens, dealTokens);
    if (score >= threshold) {
      scored.push({ deal, score });
    }
  }

  // Sort by score desc, then by price asc (cheapest first)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.deal.price_real ?? Infinity) - (b.deal.price_real ?? Infinity);
  });

  // Dedup by merchant (best match per store)
  const seen = new Set<string>();
  const results: DealMatch[] = [];
  for (const { deal } of scored) {
    if (!seen.has(deal.merchant)) {
      seen.add(deal.merchant);
      results.push({
        merchant: deal.merchant,
        itemName: deal.name,
        price: deal.price,
        priceReal: deal.price_real,
        validTo: deal.valid_to,
        imageUrl: deal.image_url ?? undefined,
      });
    }
  }

  return results;
}

/**
 * Match multiple grocery list items against deal data.
 * Returns a map of item IDs to their deal matches.
 */
export function matchListItems(
  items: { id: string; name: string }[],
  deals: FlippDealRow[],
): Map<string, DealMatch[]> {
  const results = new Map<string, DealMatch[]>();
  for (const item of items) {
    results.set(item.id, matchItemToDeals(item.name, deals));
  }
  return results;
}

// ─── Store optimization ──────────────────────────────────────────────────────

/**
 * Greedy set-cover algorithm with tie-breaking by total cost.
 *
 * Given items and their matching stores, find the minimum set of stores
 * that covers all items. When stores tie on coverage count, the one with
 * the lower total cart cost wins.
 */
export async function optimizeStoreRun(
  items: { id: string; name: string }[],
  fsa: string,
): Promise<OptimizedStoreRun> {
  // Fetch deals (cached)
  const deals = await fetchDealsForFSA(fsa);
  if (deals.length === 0) {
    return {
      stores: [],
      unmatched: items.map((i) => ({ listItemId: i.id, itemName: i.name })),
      totalStops: 0,
    };
  }

  // Match each item to its available deals
  const itemMatches = matchListItems(items, deals);

  // Build candidate set: which items can be bought at which store
  // storeMerchant -> { itemId, itemName, DealMatch }[]
  const storeCandidates = new Map<string, { itemId: string; itemName: string; deal: DealMatch }[]>();
  const allUnmatched = new Set(items.map((i) => i.id));

  for (const item of items) {
    const matches = itemMatches.get(item.id) ?? [];
    if (matches.length === 0) continue;

    allUnmatched.delete(item.id);

    for (const match of matches) {
      if (!storeCandidates.has(match.merchant)) {
        storeCandidates.set(match.merchant, []);
      }
      storeCandidates.get(match.merchant)!.push({
        itemId: item.id,
        itemName: item.name,
        deal: match,
      });
    }
  }

  // Greedy set cover: repeatedly pick the store that covers the most uncovered items
  interface StoreSelection {
    merchant: string;
    items: { itemId: string; itemName: string; deal: DealMatch }[];
    itemCount: number;
    estimatedTotal: number;
  }
  const selected: StoreSelection[] = [];
  const covered = new Set<string>();
  const remainingItemIds = new Set(
    items.map((i) => i.id).filter((id) => !allUnmatched.has(id)),
  );

  while (remainingItemIds.size > 0) {
    let bestStore: string | null = null;
    let bestCoverage = 0;
    let bestCost = Infinity;

    for (const [merchant, candidates] of storeCandidates) {
      const uncovered = candidates.filter((c) => !covered.has(c.itemId));
      const count = uncovered.length;
      if (count === 0) continue;

      const totalCost = uncovered.reduce(
        (sum, c) => sum + (c.deal.priceReal ?? 0),
        0,
      );

      // Prefer store with more uncovered items; on tie, lower total cost wins
      if (count > bestCoverage || (count === bestCoverage && totalCost < bestCost)) {
        bestStore = merchant;
        bestCoverage = count;
        bestCost = totalCost;
      }
    }

    if (!bestStore) break; // no more coverage possible

    const storeItems = storeCandidates.get(bestStore)!;
    const newlyCovered = storeItems.filter((c) => !covered.has(c.itemId));
    for (const c of newlyCovered) {
      covered.add(c.itemId);
      remainingItemIds.delete(c.itemId);
    }

    selected.push({
      merchant: bestStore,
      items: newlyCovered,
      itemCount: newlyCovered.length,
      estimatedTotal: bestCost,
    });
  }

  // Sort selected stores by item count descending
  selected.sort((a, b) => b.itemCount - a.itemCount);

  // Unmatched items
  const unmatched = items
    .filter((i) => allUnmatched.has(i.id) || !covered.has(i.id))
    .map((i) => ({ listItemId: i.id, itemName: i.name }));

  return {
    stores: selected.map((s) => ({
      merchant: s.merchant,
      items: s.items.map((it) => ({
        listItemId: it.itemId,
        itemName: it.itemName,
        deal: it.deal,
      })),
      itemCount: s.itemCount,
      estimatedTotal: s.estimatedTotal,
    })),
    unmatched,
    totalStops: selected.length,
  };
}
