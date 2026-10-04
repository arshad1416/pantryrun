/**
 * Trip Plan — Optimal multi-stop shopping plan.
 *
 * Exact enumeration for ≤7 stores (2^7 = 128 subsets), greedy fallback
 * for larger sets. Pure on-device, <5ms for typical lists.
 *
 * Plans are compared coverage-first (basket.ts `isBetterPlan`): a candidate
 * that assigns more items always beats one that assigns fewer, and cost
 * breaks ties. Line costs come from basket.ts `lineCost`, so measured
 * quantities are bought in whole packages.
 *
 * `savings` is the one-stop baseline: the cost of the best single-store
 * trip minus the optimized total. It is only reported when the baseline
 * covers exactly the same items (`savingsComparable`); otherwise it is 0
 * and the UI must say the trips aren't comparable.
 */

import type { PriceResult } from './types';
import {
  comparableSavings,
  describeEvidence,
  evaluateStores,
  isBetterPlan,
  type BasketItem,
} from './basket';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TripPlanItem {
  itemId: string;
  itemName: string;
  quantity: number;
  price: number;
  unit: string;
  /** What this line costs (whole packages); 0 when unassigned. */
  lineTotal: number;
  /** Quantity couldn't be reconciled with the price's unit — one package assumed. */
  quantityAssumed?: boolean;
  /** Where the price came from, e.g. "Flyer · ends Oct 9" (assigned items only) */
  evidence?: string;
}

export interface TripPlanStop {
  storeId: string;
  storeName: string;
  items: TripPlanItem[];
  subtotal: number;
}

export interface TripPlan {
  stops: TripPlanStop[];
  unassigned: TripPlanItem[];
  totalCost: number;
  savings: number;
  /** False when the best single store doesn't cover the same items as the plan. */
  savingsComparable: boolean;
  numStops: number;
}

type PlanItem = { id: string; name: string; quantity: number; unit: string; notes?: string };

// ─── Algorithm ──────────────────────────────────────────────────────────────

/**
 * Generate all non-empty subsets of `arr` up to size `maxSize`.
 */
function subsetsUpTo<T>(arr: T[], maxSize: number): T[][] {
  const result: T[][] = [];
  const n = arr.length;
  const limit = Math.min(maxSize, n);

  // Enumerate via bitmask (n ≤ 7 on this path)
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(arr[i]);
    }
    if (subset.length <= limit) {
      result.push(subset);
    }
  }
  return result;
}

function unassignedItem(item: PlanItem): TripPlanItem {
  return {
    itemId: item.id,
    itemName: item.name,
    quantity: item.quantity,
    price: 0,
    unit: item.unit || '',
    lineTotal: 0,
  };
}

function emptyPlan(items: PlanItem[]): TripPlan {
  return {
    stops: [],
    unassigned: items.map(unassignedItem),
    totalCost: 0,
    savings: 0,
    savingsComparable: false,
    numStops: 0,
  };
}

/** Turn a store-set evaluation into ordered stops. Empty stops are dropped. */
function toStops(
  items: PlanItem[],
  storeIds: string[],
  evaluation: ReturnType<typeof evaluateStores>,
  storeNameMap: Record<string, string>,
): TripPlanStop[] {
  return storeIds
    .map((sid) => {
      const stopItems: TripPlanItem[] = [];
      for (const item of items) {
        const a = evaluation.assignments[item.id];
        if (a?.storeId !== sid) continue;
        stopItems.push({
          itemId: item.id,
          itemName: item.name,
          quantity: item.quantity,
          price: a.price.price,
          unit: a.price.unit,
          lineTotal: a.cost,
          evidence: describeEvidence(a.price),
          ...(a.quantityAssumed ? { quantityAssumed: true } : {}),
        });
      }
      return {
        storeId: sid,
        storeName: storeNameMap[sid] ?? sid,
        items: stopItems,
        subtotal: stopItems.reduce((sum, it) => sum + it.lineTotal, 0),
      };
    })
    .filter((stop) => stop.items.length > 0);
}

/**
 * Compute the optimal trip plan.
 *
 * - If ≤7 available stores: exact enumeration of all subsets up to maxStops
 * - Otherwise: greedy fallback
 *
 * @param items  Basket items (unchecked) with id, name, quantity, unit
 * @param perStorePrices  storeId → itemId → PriceResult (already eligibility-filtered)
 * @param maxStops  Maximum number of stops (default 3)
 * @param availableStores  Store IDs to consider
 * @param storeNameMap  storeId → display name
 */
export function computeTripPlan(
  items: PlanItem[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
  maxStops: number = 3,
  availableStores?: string[],
  storeNameMap: Record<string, string> = {},
): TripPlan {
  const storeIds = availableStores ?? Object.keys(perStorePrices);
  if (storeIds.length === 0 || items.length === 0) return emptyPlan(items);

  // Stores with at least one price for at least one item
  const relevantStores = storeIds.filter((sid) =>
    items.some((item) => perStorePrices[sid]?.[item.id]),
  );
  if (relevantStores.length === 0) return emptyPlan(items);

  const basket: BasketItem[] = items;
  const evaluate = (subset: string[]) => evaluateStores(basket, subset, perStorePrices);
  const effectiveMaxStops = Math.min(maxStops, relevantStores.length);

  // One-stop baseline: the best single-store trip (coverage first, then cost).
  let bestOneStopId = relevantStores[0];
  let bestOneStop = evaluate([bestOneStopId]);
  for (const sid of relevantStores.slice(1)) {
    const result = evaluate([sid]);
    if (isBetterPlan(result, bestOneStop)) {
      bestOneStop = result;
      bestOneStopId = sid;
    }
  }

  let bestSubset = [bestOneStopId];
  let bestResult = bestOneStop;

  if (relevantStores.length <= 7) {
    // ── Exact enumeration ────────────────────────────────────────────────
    for (const subset of subsetsUpTo(relevantStores, effectiveMaxStops)) {
      const result = evaluate(subset);
      if (isBetterPlan(result, bestResult)) {
        bestResult = result;
        bestSubset = subset;
      }
    }
  } else {
    // ── Greedy fallback ──────────────────────────────────────────────────
    // Start with the best single store, greedily add stores that improve
    // the plan (more coverage, or equal coverage at lower cost).
    const selected = [bestOneStopId];
    while (selected.length < effectiveMaxStops) {
      let bestCandidate: string | null = null;
      let bestCandidateResult = bestResult;
      for (const sid of relevantStores) {
        if (selected.includes(sid)) continue;
        const result = evaluate([...selected, sid]);
        if (isBetterPlan(result, bestCandidateResult)) {
          bestCandidateResult = result;
          bestCandidate = sid;
        }
      }
      if (bestCandidate === null) break;
      selected.push(bestCandidate);
      bestResult = bestCandidateResult;
    }
    bestSubset = selected;
  }

  const stops = toStops(items, bestSubset, bestResult, storeNameMap);
  const missing = new Set(bestResult.missing);
  const savings = comparableSavings(bestResult, bestOneStop);

  return {
    stops,
    unassigned: items.filter((it) => missing.has(it.id)).map(unassignedItem),
    totalCost: bestResult.total,
    savings: savings ?? 0,
    savingsComparable: savings !== null,
    numStops: stops.length,
  };
}
