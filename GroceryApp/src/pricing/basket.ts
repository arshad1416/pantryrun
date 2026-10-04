/**
 * Basket — the single source of truth for what a price comparison covers.
 *
 * Every surface that shows a total (store pills, route cards, route
 * sections, Plan My Trip) goes through this module so they agree on:
 *
 *  - which items are in the basket (unchecked, not deleted, this list,
 *    quantity not explicitly 0)
 *  - which offers are eligible for an item on the shopping date
 *    (eligibility.ts) and what buying the item there costs (quantity.ts)
 *  - the status of every line: costed, held (sale only, no qualifying
 *    sale), or not costed with the reasons — never "free", never dropped
 *  - the optimal plan over at most N distinct stores (exact enumeration of
 *    store sets; each line bought entirely at one store of the set)
 *  - when a savings figure is honest: only against a baseline built from
 *    the same analysis (same basket, quantities, rules, date and offers)
 *    that costs exactly the same lines
 *  - when a plan may claim "cheapest": only when it is complete, exact,
 *    and every line is backed by verified evidence
 *
 * Pure functions only — no store, network or React imports.
 */

import type { PriceResult } from './types';
import { parseItemIntent, type ItemIntent } from './intent';
import {
  assessOffer,
  shoppingWindow,
  type EvidenceCaveat,
  type IneligibleReason,
  type PlanContext,
} from './eligibility';
import {
  parseRequirement,
  purchaseFor,
  type Purchase,
  type PurchaseFailure,
} from './quantity';

export { STOP_WORDS, extractKeywords, matchScore } from './intent';
export type { PlanContext } from './eligibility';

// ─── Basket selection ───────────────────────────────────────────────────────

export interface BasketItem {
  id: string;
  name: string;
  /** null = unknown. 0 never reaches a basket (selectBasketItems drops it). */
  quantity: number | null;
  unit?: string;
  notes?: string;
}

/**
 * Items still to buy on this list. Checked items and items with an
 * explicit quantity of 0 are never priced or planned.
 */
export function selectBasketItems<
  T extends { listId: string; isDeleted: boolean; isChecked: boolean; quantity?: number | null },
>(items: Record<string, T> | T[], listId: string): T[] {
  const all = Array.isArray(items) ? items : Object.values(items);
  return all.filter(
    (i) => i.listId === listId && !i.isDeleted && !i.isChecked && i.quantity !== 0,
  );
}

// ─── Offers ─────────────────────────────────────────────────────────────────

/** One store may offer several candidates for an item (e.g. 2% and lactose-free milk). */
export type Offers = PriceResult | PriceResult[];
/** storeId → itemId → offer(s) */
export type StoreOffers = Record<string, Record<string, Offers | undefined>>;

function offerList(o: Offers | undefined): PriceResult[] {
  if (!o) return [];
  return Array.isArray(o) ? o : [o];
}

// ─── Analysis (per item, per store) ─────────────────────────────────────────

export type RejectionReason = IneligibleReason | PurchaseFailure;

export interface LineOption {
  storeId: string;
  offer: PriceResult;
  purchase: Purchase;
  verified: boolean;
  caveats: EvidenceCaveat[];
}

export interface OfferRejection {
  storeId: string;
  offer: PriceResult;
  reasons: RejectionReason[];
}

export type QuantityIssue = 'quantity_unknown' | 'quantity_invalid' | 'unit_unknown';

export interface ItemAnalysis {
  item: BasketItem;
  intent: ItemIntent;
  /** Set when the quantity itself prevents costing at any store. */
  quantityIssue?: QuantityIssue;
  /** Best usable option per store, sorted by store ID. */
  options: LineOption[];
  rejections: OfferRejection[];
}

export interface BasketAnalysis {
  items: ItemAnalysis[];
  /** Stores with at least one usable option, sorted. */
  storeIds: string[];
  /**
   * Fingerprint of everything the analysis assumed: basket lines, rules,
   * shopping window, policies and the usable offers. Plans are only
   * comparable when this matches.
   */
  contextKey: string;
}

/** Cheaper first; at equal cost verified evidence first. */
function betterOption(a: LineOption, b: LineOption): boolean {
  if (a.purchase.costCents !== b.purchase.costCents) return a.purchase.costCents < b.purchase.costCents;
  if (a.verified !== b.verified) return a.verified;
  return false;
}

/** FNV-1a — short, stable fingerprint for a context string. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + text.length.toString(16);
}

/**
 * Assess every offer for every basket item once. Plans, route cards and
 * savings are all derived from one analysis so they can't disagree.
 */
export function analyzeBasket(
  items: BasketItem[],
  offers: StoreOffers,
  ctx: PlanContext = {},
  storeFilter?: string[],
): BasketAnalysis {
  const storeIds = Object.keys(offers)
    .filter((sid) => !storeFilter || storeFilter.includes(sid))
    .sort();
  const usableStores = new Set<string>();

  const analyses = items.map((item): ItemAnalysis => {
    const intent = parseItemIntent(item);
    const req = parseRequirement(item.quantity, item.unit);
    const rejections: OfferRejection[] = [];
    const options: LineOption[] = [];
    // An explicit 0 is excluded by selectBasketItems; treat a stray one as unknown.
    const quantityIssue: QuantityIssue | undefined = req.ok
      ? undefined
      : req.reason === 'quantity_zero' ? 'quantity_unknown' : req.reason;

    for (const storeId of storeIds) {
      let best: LineOption | null = null;
      for (const offer of offerList(offers[storeId]?.[item.id])) {
        const a = assessOffer(offer, item, ctx, intent);
        if (!a.eligible) {
          rejections.push({ storeId, offer, reasons: a.reasons });
          continue;
        }
        if (!req.ok) continue;
        const p = purchaseFor(req.requirement, offer);
        if (!p.ok) {
          rejections.push({ storeId, offer, reasons: [p.reason] });
          continue;
        }
        const option: LineOption = {
          storeId, offer, purchase: p.purchase, verified: a.verified, caveats: a.caveats,
        };
        if (!best || betterOption(option, best)) best = option;
      }
      if (best) {
        options.push(best);
        usableStores.add(storeId);
      }
    }
    return { item, intent, quantityIssue, options, rejections };
  });

  const w = shoppingWindow(ctx);
  const key = JSON.stringify({
    items: items.map((i) => [i.id, i.name, i.notes ?? '', i.quantity, i.unit ?? '']),
    window: [w.from, w.through, w.timeZone],
    policy: [
      !!ctx.includeDemo, [...(ctx.memberships ?? [])].sort(), ctx.channel ?? '', ctx.city ?? '',
      ctx.branchIds ?? {}, !!ctx.requireHeldItems,
    ],
    offers: analyses.map((a) => a.options.map((o) => [o.storeId, o.purchase.costCents, o.verified])),
  });

  return { items: analyses, storeIds: [...usableStores].sort(), contextKey: fingerprint(key) };
}

// ─── Plans ──────────────────────────────────────────────────────────────────

export type LineStatus =
  | 'costed'
  /** "sale only" and no qualifying sale at the plan's stores */
  | 'held'
  /** no usable offer at the plan's stores */
  | 'unavailable'
  | QuantityIssue;

export interface PlanLine {
  itemId: string;
  itemName: string;
  status: LineStatus;
  /** Set when costed */
  option?: LineOption;
  /** Why the line isn't costed (unique, most specific first). Empty when costed. */
  reasons: string[];
}

export type Fulfillment = 'complete' | 'complete_with_holds' | 'incomplete';
export type PlanClaim = 'verified' | 'estimate' | 'none';

export interface BasketPlan {
  contextKey: string;
  maxStops: number;
  /** Stores the plan actually visits, sorted. A store with no lines is not a stop. */
  storeIds: string[];
  lines: PlanLine[];
  totalCents: number;
  costedCount: number;
  heldCount: number;
  /** Lines neither costed nor held */
  blockedCount: number;
  totalCount: number;
  fulfillment: Fulfillment;
  /**
   * 'verified' — complete, exact and every line backed by verified evidence;
   * 'estimate' — complete but some evidence is unverified (or search was not exact);
   * 'none'     — incomplete: no "cheapest basket" claim may be made.
   */
  claim: PlanClaim;
  exact: boolean;
}

function lineReasons(a: ItemAnalysis, subset: Set<string>): string[] {
  if (a.quantityIssue) return [a.quantityIssue];
  const out: string[] = [];
  if (a.options.some((o) => !subset.has(o.storeId))) out.push('not_at_selected_stores');
  for (const r of a.rejections) for (const reason of r.reasons) out.push(reason);
  if (out.length === 0) out.push('no_offer');
  return [...new Set(out)];
}

/** Cost the basket at exactly this set of stores (each line at its cheapest store in the set). */
export function planForStores(
  analysis: BasketAnalysis,
  storeIds: string[],
  opts: { maxStops?: number; exact?: boolean; requireHeldItems?: boolean } = {},
): BasketPlan {
  const subset = new Set(storeIds);
  const used = new Set<string>();
  let totalCents = 0;
  let costedCount = 0;
  let heldCount = 0;
  let allVerified = true;

  const lines = analysis.items.map((a): PlanLine => {
    const base = { itemId: a.item.id, itemName: a.item.name };
    if (a.quantityIssue) return { ...base, status: a.quantityIssue, reasons: [a.quantityIssue] };
    let best: LineOption | null = null;
    for (const o of a.options) {
      if (!subset.has(o.storeId)) continue;
      // options are sorted by store ID, so an equal-cost later store never wins
      if (!best || betterOption(o, best)) best = o;
    }
    if (best) {
      used.add(best.storeId);
      totalCents += best.purchase.costCents;
      costedCount++;
      if (!best.verified) allVerified = false;
      return { ...base, status: 'costed', option: best, reasons: [] };
    }
    if (a.intent.saleOnly) {
      heldCount++;
      return { ...base, status: 'held', reasons: lineReasons(a, subset) };
    }
    return { ...base, status: 'unavailable', reasons: lineReasons(a, subset) };
  });

  const totalCount = lines.length;
  const blockedCount = totalCount - costedCount - heldCount;
  const fulfillment: Fulfillment =
    blockedCount > 0 || (heldCount > 0 && opts.requireHeldItems) ? 'incomplete'
      : heldCount > 0 ? 'complete_with_holds'
      : 'complete';
  const exact = opts.exact ?? true;
  const claim: PlanClaim =
    fulfillment === 'incomplete' || totalCount === 0 ? 'none'
      : exact && allVerified ? 'verified'
      : 'estimate';

  return {
    contextKey: analysis.contextKey,
    maxStops: opts.maxStops ?? storeIds.length,
    storeIds: [...used].sort(),
    lines,
    totalCents,
    costedCount,
    heldCount,
    blockedCount,
    totalCount,
    fulfillment,
    claim,
    exact,
  };
}

/**
 * Plan order: more costed lines first; then lower total; then fewer stops;
 * then store IDs alphabetically — so ties resolve the same way every time.
 */
export function comparePlans(a: BasketPlan, b: BasketPlan): number {
  if (a.costedCount !== b.costedCount) return b.costedCount - a.costedCount;
  if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
  if (a.storeIds.length !== b.storeIds.length) return a.storeIds.length - b.storeIds.length;
  const ak = a.storeIds.join('\u0000');
  const bk = b.storeIds.join('\u0000');
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/** Above this many store sets the solver falls back to greedy and says so (exact: false). */
export const EXACT_SUBSET_LIMIT = 20000;

function countSubsets(n: number, k: number): number {
  let total = 0;
  let c = 1;
  for (let i = 1; i <= k; i++) {
    c = (c * (n - i + 1)) / i;
    total += c;
    if (total > EXACT_SUBSET_LIMIT) return total;
  }
  return total;
}

function* subsetsUpTo<T>(arr: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i]);
    yield [...acc];
    if (acc.length < k) yield* subsetsUpTo(arr, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * The best plan visiting at most `maxStops` distinct stores. Exact: every
 * store set of size 1..maxStops is costed — never "each item's cheapest
 * store", which can need more stops than allowed.
 */
export function solvePlan(
  analysis: BasketAnalysis,
  maxStops: number,
  opts: { requireHeldItems?: boolean } = {},
): BasketPlan {
  const k = Math.max(0, Math.floor(maxStops));
  const stores = analysis.storeIds;
  const base = { maxStops: k, requireHeldItems: opts.requireHeldItems };
  if (k === 0 || stores.length === 0) return planForStores(analysis, [], base);

  const limit = Math.min(k, stores.length);
  let best: BasketPlan | null = null;

  if (countSubsets(stores.length, limit) <= EXACT_SUBSET_LIMIT) {
    for (const subset of subsetsUpTo(stores, limit)) {
      const plan = planForStores(analysis, subset, base);
      if (!best || comparePlans(plan, best) < 0) best = plan;
    }
    return best!;
  }

  // Greedy fallback for very large store sets — flagged as not exact.
  const selected: string[] = [];
  while (selected.length < limit) {
    let next: BasketPlan | null = null;
    let nextStore: string | null = null;
    for (const sid of stores) {
      if (selected.includes(sid)) continue;
      const plan = planForStores(analysis, [...selected, sid], { ...base, exact: false });
      if (!next || comparePlans(plan, next) < 0) { next = plan; nextStore = sid; }
    }
    if (!next || !nextStore || (best && comparePlans(next, best) >= 0)) break;
    selected.push(nextStore);
    best = next;
  }
  return best ?? planForStores(analysis, [], { ...base, exact: false });
}

// ─── Savings ────────────────────────────────────────────────────────────────

export type Savings =
  | { status: 'available'; amountCents: number }
  | { status: 'unavailable'; reason: 'different_assumptions' | 'different_coverage' | 'no_baseline' };

/**
 * Merchandise savings of `plan` against `baseline`. Only available when
 * both come from the same analysis and cost exactly the same lines; a
 * lower total that buys fewer things is not a saving. Travel and other
 * costs are not included. A zero is reported only when the totals are equal.
 */
export function compareSavings(plan: BasketPlan, baseline: BasketPlan | null | undefined): Savings {
  if (!baseline || baseline.totalCount === 0 || baseline.costedCount === 0) {
    return { status: 'unavailable', reason: 'no_baseline' };
  }
  if (plan.contextKey !== baseline.contextKey) return { status: 'unavailable', reason: 'different_assumptions' };
  const costed = (p: BasketPlan) => p.lines.filter((l) => l.status === 'costed').map((l) => l.itemId).join('|');
  if (costed(plan) !== costed(baseline)) return { status: 'unavailable', reason: 'different_coverage' };
  return { status: 'available', amountCents: baseline.totalCents - plan.totalCents };
}

// ─── Compatibility helpers (single offer, single item) ──────────────────────

/** Why `pr` cannot be used for `item`, or null when it can. */
export function ineligibleReason(
  pr: PriceResult,
  item: Pick<BasketItem, 'name' | 'notes'>,
  ctx: PlanContext = {},
): IneligibleReason | null {
  return assessOffer(pr, item, ctx).reasons[0] ?? null;
}

/**
 * Keep, per store and item, the cheapest offer that is eligible on the
 * shopping date. Stores left empty are removed. (Purchase math is not
 * applied — use analyzeBasket for totals.)
 */
export function filterEligiblePrices(
  items: Pick<BasketItem, 'id' | 'name' | 'notes'>[],
  perStoreOffers: StoreOffers,
  ctx: PlanContext = {},
): Record<string, Record<string, PriceResult>> {
  const out: Record<string, Record<string, PriceResult>> = {};
  for (const [storeId, prices] of Object.entries(perStoreOffers)) {
    const kept: Record<string, PriceResult> = {};
    for (const item of items) {
      const eligible = offerList(prices[item.id])
        .filter((pr) => assessOffer(pr, item, ctx).eligible)
        .sort((a, b) => a.price - b.price);
      if (eligible[0]) kept[item.id] = eligible[0];
    }
    if (Object.keys(kept).length > 0) out[storeId] = kept;
  }
  return out;
}

export type LineCost =
  | { cost: number; purchase: Purchase; reason: null }
  | { cost: null; purchase: null; reason: PurchaseFailure | QuantityIssue };

/** What buying `item` at offer `pr` costs, or why it can't be costed. */
export function lineCost(item: Pick<BasketItem, 'quantity' | 'unit'>, pr: PriceResult): LineCost {
  const req = parseRequirement(item.quantity, item.unit);
  if (!req.ok) {
    return { cost: null, purchase: null, reason: req.reason === 'quantity_zero' ? 'quantity_unknown' : req.reason };
  }
  const p = purchaseFor(req.requirement, pr);
  if (!p.ok) return { cost: null, purchase: null, reason: p.reason };
  return { cost: p.purchase.costCents / 100, purchase: p.purchase, reason: null };
}

// ─── Evidence ───────────────────────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  official: 'Store',
  flyer: 'Flyer',
  crowd: 'Crowd',
  scraping: 'Web',
};

function shortDate(d: Date, timeZone?: string): string {
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

/**
 * Short provenance label for a price, e.g. "Flyer · ends Oct 9",
 * "Crowd · 3d ago", "Demo", "Last known · refresh failed" — so a seeded,
 * old or withdrawn price never reads as a current shelf price.
 */
export function describeEvidence(pr: PriceResult, now: number = Date.now()): string {
  if (pr.isDemo) return 'Demo';
  if (pr.unavailable === 'withdrawn') return 'No longer offered';
  const tier = TIER_LABELS[pr.source.tier] ?? pr.source.tier;
  if (pr.refreshFailedAt !== undefined) return `${tier} · last known (refresh failed)`;
  if (pr.validThroughDate !== undefined) {
    // Date-only end: format the calendar date itself, not an instant.
    const [y, m, d] = pr.validThroughDate.split('-').map(Number);
    return `${tier} · ends ${shortDate(new Date(Date.UTC(y, m - 1, d, 12)), 'UTC')}`;
  }
  if (pr.validTo !== undefined) {
    return `${tier} · ends ${shortDate(new Date(pr.validTo), pr.source.timeZone)}`;
  }
  const days = Math.floor((now - pr.timestamp) / (24 * 60 * 60 * 1000));
  return `${tier} · ${days <= 0 ? 'today' : `${days}d ago`}`;
}

const REASON_LABELS: Record<string, string> = {
  quantity_unknown: 'quantity unknown',
  quantity_invalid: 'invalid quantity',
  unit_unknown: 'unit not recognised',
  not_at_selected_stores: 'only at stores not on this route',
  no_offer: 'no price found',
  withdrawn: 'offer withdrawn',
  expired: 'offer expired',
  expires_before_shopping: 'offer ends before your shopping date',
  not_started: 'offer not started yet',
  stale: 'price too old',
  demo: 'demo price',
  out_of_stock: 'out of stock',
  membership_unconfirmed: 'membership not confirmed',
  wrong_channel: 'different channel (online/in-store)',
  wrong_city: 'different city',
  wrong_branch: 'different branch',
  not_on_sale: 'no qualifying sale',
  variant_mismatch: 'different variant',
  variant_unverified: 'variant not confirmed',
  unit_incompatible: 'sold in a different unit',
  pack_size_unknown: 'pack size unknown',
  exceeds_limit: 'over the purchase limit',
  insufficient_stock: 'not enough stock',
};

/** Human label for a line or offer reason. */
export function describeReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}
