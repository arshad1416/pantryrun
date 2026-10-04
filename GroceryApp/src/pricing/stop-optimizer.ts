/**
 * Stop Optimizer — multi-stop route proposals (the route cards).
 *
 * Pure algorithm: given basket items and per-store prices, proposes a
 * 1-stop, 2-stop, … route by greedy expansion. Ranking is coverage-first
 * (basket.ts `isBetterPlan`), so a store carrying three cheap items never
 * beats one that carries the whole basket. Each proposal says how many
 * items it covers, and `savingsVsOneStop` is null whenever the 1-stop
 * baseline doesn't cover the same items.
 */

import type { PriceResult } from './types';
import {
  comparableSavings,
  evaluateStores,
  isBetterPlan,
  type BasketItem,
} from './basket';

export interface StopProposal {
  numStops: number;
  stores: { storeId: string; storeName: string }[];
  totalCost: number;
  /** null = the 1-stop baseline covers different items, so no honest comparison. */
  savingsVsOneStop: number | null;
  /**
   * Merchandise saved by this route's last added stop vs the previous
   * proposal — null for the first proposal or when the added stop changes
   * which items are covered. Travel, tax and time are not included.
   */
  incrementalSavings: number | null;
  coveredCount: number;
  totalCount: number;
  /** Item IDs this route can't supply (includes `heldItemIds`) */
  missingItemIds: string[];
  /** Sale-only items with no qualifying sale — deliberately not bought. */
  heldItemIds: string[];
}

/**
 * Compute multi-stop shopping proposals.
 *
 * - Early return [] if < 2 stores have prices for basket items
 * - 1-stop proposal: best single store, coverage first then cost
 * - Greedy additions: add the store that most improves the plan, up to
 *   `maxStops`; stop when no store improves it
 */
export function computeStopProposals(
  items: { id: string; quantity: number; unit?: string; name?: string; notes?: string }[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
  storeNameMap: Record<string, string>,
  maxStops: number = 3,
): StopProposal[] {
  const basket: BasketItem[] = items.map((i) => ({ ...i, name: i.name ?? '' }));
  const availableStoreIds = Object.keys(perStorePrices).filter((sid) =>
    items.some((item) => perStorePrices[sid]?.[item.id]),
  );
  if (availableStoreIds.length < 2) return [];

  const evaluate = (storeIds: string[]) => evaluateStores(basket, storeIds, perStorePrices);

  let bestOneStopId = availableStoreIds[0];
  let baseline = evaluate([bestOneStopId]);
  for (const sid of availableStoreIds.slice(1)) {
    const result = evaluate([sid]);
    if (isBetterPlan(result, baseline)) {
      baseline = result;
      bestOneStopId = sid;
    }
  }

  const toProposal = (
    selected: string[],
    result: ReturnType<typeof evaluate>,
    previous: ReturnType<typeof evaluate> | null,
  ): StopProposal => ({
    numStops: selected.length,
    stores: selected.map((sid) => ({ storeId: sid, storeName: storeNameMap[sid] ?? sid })),
    totalCost: result.total,
    savingsVsOneStop: comparableSavings(result, baseline),
    incrementalSavings: previous ? comparableSavings(result, previous) : null,
    coveredCount: items.length - result.missing.length,
    totalCount: items.length,
    missingItemIds: result.missing,
    heldItemIds: result.held,
  });

  const selected = [bestOneStopId];
  let current = baseline;
  const proposals: StopProposal[] = [toProposal(selected, current, null)];
  const limit = Math.min(maxStops, availableStoreIds.length);

  while (selected.length < limit) {
    let bestNextId: string | null = null;
    let bestNext = current;
    for (const sid of availableStoreIds) {
      if (selected.includes(sid)) continue;
      const result = evaluate([...selected, sid]);
      if (isBetterPlan(result, bestNext)) {
        bestNext = result;
        bestNextId = sid;
      }
    }
    if (bestNextId === null) break;

    selected.push(bestNextId);
    proposals.push(toProposal(selected, bestNext, current));
    current = bestNext;
  }

  return proposals;
}
