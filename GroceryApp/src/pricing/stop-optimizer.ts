/**
 * Stop Optimizer — multi-stop route proposals (the route cards).
 *
 * One proposal per distinct optimal plan for "at most 1, 2, … maxStops
 * stores", from basket.ts's exact solver — the same solver Plan My Trip
 * uses, so a route card and the trip sheet never disagree. A route that
 * would add a stop without changing the plan isn't repeated.
 *
 * Ranking is coverage-first, so a store carrying three cheap items never
 * beats one that carries the whole basket. Each proposal says how many
 * lines it costs, which it holds ("sale only") and which it can't supply.
 * `savingsVsOneStop` is null whenever the 1-stop baseline doesn't cost the
 * same lines — a missing comparison is not a $0 saving.
 */

import type { PriceResult } from './types';
import {
  analyzeBasket,
  compareSavings,
  solvePlan,
  type BasketAnalysis,
  type BasketItem,
  type BasketPlan,
  type PlanContext,
  type StoreOffers,
} from './basket';

export interface StopProposal {
  numStops: number;
  stores: { storeId: string; storeName: string }[];
  totalCost: number;
  /** null = the 1-stop baseline costs different lines, so no honest comparison. */
  savingsVsOneStop: number | null;
  /** Lines this route costs */
  coveredCount: number;
  totalCount: number;
  /** Item IDs this route can't supply (not costed, not held) */
  missingItemIds: string[];
  /** "Sale only" item IDs with no qualifying sale on this route */
  heldItemIds: string[];
  plan: BasketPlan;
}

function toProposal(plan: BasketPlan, baseline: BasketPlan, storeNameMap: Record<string, string>): StopProposal {
  const savings = compareSavings(plan, baseline);
  return {
    numStops: plan.storeIds.length,
    stores: plan.storeIds.map((sid) => ({ storeId: sid, storeName: storeNameMap[sid] ?? sid })),
    totalCost: plan.totalCents / 100,
    savingsVsOneStop: savings.status === 'available' ? savings.amountCents / 100 : null,
    coveredCount: plan.costedCount,
    totalCount: plan.totalCount,
    missingItemIds: plan.lines.filter((l) => l.status !== 'costed' && l.status !== 'held').map((l) => l.itemId),
    heldItemIds: plan.lines.filter((l) => l.status === 'held').map((l) => l.itemId),
    plan,
  };
}

/** Route proposals from an existing analysis. */
export function proposalsFromAnalysis(
  analysis: BasketAnalysis,
  storeNameMap: Record<string, string>,
  maxStops: number = 3,
  ctx: Pick<PlanContext, 'requireHeldItems'> = {},
): StopProposal[] {
  if (analysis.storeIds.length < 2) return [];
  const baseline = solvePlan(analysis, 1, ctx);
  const proposals: StopProposal[] = [];
  const seen = new Set<string>();
  for (let k = 1; k <= Math.min(maxStops, analysis.storeIds.length); k++) {
    const plan = k === 1 ? baseline : solvePlan(analysis, k, ctx);
    const key = plan.storeIds.join('|');
    if (seen.has(key) || plan.storeIds.length === 0) continue;
    seen.add(key);
    proposals.push(toProposal(plan, baseline, storeNameMap));
  }
  return proposals;
}

/**
 * Compute multi-stop shopping proposals. Returns [] when fewer than two
 * stores have a usable offer for any basket item.
 */
export function computeStopProposals(
  items: { id: string; quantity: number | null; unit?: string; name?: string; notes?: string }[],
  perStorePrices: StoreOffers | Record<string, Record<string, PriceResult>>,
  storeNameMap: Record<string, string>,
  maxStops: number = 3,
  ctx: PlanContext = {},
): StopProposal[] {
  const basket: BasketItem[] = items.map((i) => ({ ...i, name: i.name ?? '' }));
  return proposalsFromAnalysis(analyzeBasket(basket, perStorePrices as StoreOffers, ctx), storeNameMap, maxStops, ctx);
}
