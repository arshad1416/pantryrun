/**
 * Trip Plan — the optimal shopping plan over at most `maxStops` stores,
 * shaped for TripPlanSheet.
 *
 * All decisions are basket.ts's: eligibility on the shopping date, package
 * and weighed-goods math, the exact bounded-store solver, holds for "sale
 * only" items, and honest savings. This module only reshapes a BasketPlan
 * into stops and line rows.
 *
 * `savings` is merchandise savings against the best single-store trip,
 * computed from the same analysis. It is null (unavailable — not $0)
 * whenever that baseline doesn't cost exactly the same lines.
 */

import type { PriceResult } from './types';
import {
  analyzeBasket,
  compareSavings,
  describeEvidence,
  solvePlan,
  type BasketItem,
  type BasketPlan,
  type Fulfillment,
  type PlanClaim,
  type PlanContext,
  type PlanLine,
  type StoreOffers,
} from './basket';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TripPlanItem {
  itemId: string;
  itemName: string;
  quantity: number | null;
  /** Offer price; null when the line isn't costed (never coerced to 0). */
  price: number | null;
  unit: string;
  /** What this line costs; null when not costed. */
  lineTotal: number | null;
  /** Where the price came from, e.g. "Flyer · ends Oct 9" (costed lines) */
  evidence?: string;
  /** Costed with verified evidence */
  verified?: boolean;
  /** Amount bought, e.g. "680 g" (costed lines) */
  purchased?: string;
  /** Arithmetic, e.g. "2 × $2.99" (costed lines) */
  breakdown?: string;
  /** Why the line isn't costed (uncosted lines) */
  reasons?: string[];
}

export interface TripPlanStop {
  storeId: string;
  storeName: string;
  items: TripPlanItem[];
  subtotal: number;
}

export interface TripPlan {
  stops: TripPlanStop[];
  /** Lines with no usable offer at the plan's stores (or an unusable quantity) */
  unassigned: TripPlanItem[];
  /** "Sale only" lines with no qualifying sale */
  held: TripPlanItem[];
  totalCost: number;
  /** Merchandise savings vs. the best single store; null = no comparable baseline. */
  savings: number | null;
  savingsComparable: boolean;
  numStops: number;
  costedCount: number;
  totalCount: number;
  fulfillment: Fulfillment;
  claim: PlanClaim;
  exact: boolean;
  contextKey: string;
}

type PlanItem = BasketItem & { unit?: string };

function itemRow(item: PlanItem, line: PlanLine, now: number): TripPlanItem {
  const o = line.option;
  if (!o) {
    return {
      itemId: item.id,
      itemName: item.name,
      quantity: item.quantity,
      price: null,
      unit: item.unit || '',
      lineTotal: null,
      reasons: line.reasons,
    };
  }
  return {
    itemId: item.id,
    itemName: item.name,
    quantity: item.quantity,
    price: o.offer.price,
    unit: o.offer.unit,
    lineTotal: o.purchase.costCents / 100,
    evidence: describeEvidence(o.offer, now),
    verified: o.verified,
    purchased: o.purchase.purchasedLabel,
    breakdown: o.purchase.breakdown,
  };
}

/** Reshape a solved plan for the trip sheet. */
export function toTripPlan(
  items: PlanItem[],
  plan: BasketPlan,
  baseline: BasketPlan | null,
  storeNameMap: Record<string, string> = {},
  now: number = Date.now(),
): TripPlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = plan.lines.map((l) => ({ line: l, row: itemRow(byId.get(l.itemId)!, l, now) }));

  const stops: TripPlanStop[] = plan.storeIds.map((sid) => {
    const stopRows = rows.filter((r) => r.line.option?.storeId === sid).map((r) => r.row);
    const cents = rows
      .filter((r) => r.line.option?.storeId === sid)
      .reduce((sum, r) => sum + r.line.option!.purchase.costCents, 0);
    return { storeId: sid, storeName: storeNameMap[sid] ?? sid, items: stopRows, subtotal: cents / 100 };
  });

  const savings = compareSavings(plan, baseline);
  return {
    stops,
    unassigned: rows.filter((r) => r.line.status !== 'costed' && r.line.status !== 'held').map((r) => r.row),
    held: rows.filter((r) => r.line.status === 'held').map((r) => r.row),
    totalCost: plan.totalCents / 100,
    savings: savings.status === 'available' ? savings.amountCents / 100 : null,
    savingsComparable: savings.status === 'available',
    numStops: stops.length,
    costedCount: plan.costedCount,
    totalCount: plan.totalCount,
    fulfillment: plan.fulfillment,
    claim: plan.claim,
    exact: plan.exact,
    contextKey: plan.contextKey,
  };
}

/**
 * Compute the optimal trip plan.
 *
 * @param items  Basket items (unchecked, non-zero quantity)
 * @param perStorePrices  storeId → itemId → offer(s); eligibility is applied here
 * @param maxStops  Maximum number of distinct stores (default 3)
 * @param availableStores  Store IDs to consider (default: all)
 * @param storeNameMap  storeId → display name
 * @param ctx  Shopping date, time zone, memberships, channel… (default: today)
 */
export function computeTripPlan(
  items: PlanItem[],
  perStorePrices: StoreOffers | Record<string, Record<string, PriceResult>>,
  maxStops: number = 3,
  availableStores?: string[],
  storeNameMap: Record<string, string> = {},
  ctx: PlanContext = {},
): TripPlan {
  const analysis = analyzeBasket(items, perStorePrices as StoreOffers, ctx, availableStores);
  const plan = solvePlan(analysis, maxStops, ctx);
  const baseline = solvePlan(analysis, 1, ctx);
  return toTripPlan(items, plan, baseline, storeNameMap, ctx.now);
}
