/**
 * Basket — the single source of truth for what a price comparison covers.
 *
 * Every surface that shows a total (store pills, route cards, route
 * sections, Plan My Trip) goes through this module so they agree on:
 *
 *  - which items are in the basket (unchecked, not deleted, this list)
 *  - which prices are eligible for an item (not expired, not stale, not
 *    demo data, matching the requested variant and any "sale only" note)
 *  - what a line costs (whole packages for measured quantities)
 *  - how plans are ranked (coverage first, cost second) and when a
 *    savings figure is honest (only against a baseline covering the same
 *    items)
 *
 * Pure functions only — no store, network or React imports.
 */

import type { PriceResult } from './types';

// ─── Basket selection ───────────────────────────────────────────────────────

export interface BasketItem {
  id: string;
  name: string;
  quantity: number;
  unit?: string;
  notes?: string;
}

/** Items still to buy on this list. Checked items are never priced or planned. */
export function selectBasketItems<
  T extends { listId: string; isDeleted: boolean; isChecked: boolean },
>(items: Record<string, T> | T[], listId: string): T[] {
  const all = Array.isArray(items) ? items : Object.values(items);
  return all.filter((i) => i.listId === listId && !i.isDeleted && !i.isChecked);
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** Words that add no matching value in grocery context */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'without', 'fresh', 'frozen', 'organic', 'natural', 'premium',
  'value', 'selected', 'choice', 'best', 'plus', 'all', 'each', 'per',
  'pack', 'bag', 'box', 'bottle', 'can', 'jar', 'tub', 'tray', 'bunch',
  'kg', 'g', 'ml', 'l', 'oz', 'lb', 'litre', 'liter', 'gram', 'grams',
  'piece', 'pieces', 'count', 'size', 'large', 'medium', 'small',
  'grade', 'type', 'style', 'brand', 'save', 'caisse', 'chaque',
]);

/** Crude plural folding so "grapes" ≡ "grape" and "patties" ≡ "patty". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('oes')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Meaningful, stemmed tokens of a product name. Hyphens split ("lactose-free"). */
export function extractKeywords(name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Score how well query tokens match product tokens (0..1). Whole tokens
 * only — "milk" must not match "buttermilk". Multi-word queries need at
 * least two hits so "green grapes" does not match "red grapes".
 */
export function matchScore(queryTokens: string[], productTokens: string[]): number {
  if (queryTokens.length === 0 || productTokens.length === 0) return 0;
  const product = new Set(productTokens);
  const hits = queryTokens.filter((t) => product.has(t)).length;
  if (hits < 2 && queryTokens.length > 1) return 0;
  return hits / queryTokens.length;
}

// ─── Constraints ────────────────────────────────────────────────────────────

export interface ItemConstraints {
  /** Tokens that must all appear in the matched product name. */
  requiredTokens: string[];
  /** Tokens that only a note demanded — unverifiable without a matched name. */
  noteTokens: string[];
  saleOnly: boolean;
}

const SALE_ONLY_RE = /\b(sale only|only (if )?on sale|on sale only|if on sale|when on sale)\b/i;
const NOTE_REQUIREMENT_RES = [
  /\bmust be ([a-z0-9 -]+)/i,
  /\bonly ([a-z0-9 -]+)/i,
  /\b([a-z0-9-]+) only\b/i,
];

/**
 * Read the shopping rules a person wrote on an item. Grammar is deliberately
 * small: the item name's own words, "sale only" style phrases, and
 * "must be X" / "only X" / "X only" in notes.
 */
export function parseItemConstraints(item: Pick<BasketItem, 'name' | 'notes'>): ItemConstraints {
  const nameTokens = extractKeywords(item.name);
  const notes = item.notes ?? '';
  const saleOnly = SALE_ONLY_RE.test(notes);

  const noteTokens: string[] = [];
  const withoutSale = notes.replace(SALE_ONLY_RE, ' ');
  for (const re of NOTE_REQUIREMENT_RES) {
    const m = withoutSale.match(re);
    if (m?.[1]) {
      for (const t of extractKeywords(m[1])) {
        if (t !== 'sale' && !nameTokens.includes(t) && !noteTokens.includes(t)) {
          noteTokens.push(t);
        }
      }
    }
  }

  return { requiredTokens: [...nameTokens, ...noteTokens], noteTokens, saleOnly };
}

// ─── Eligibility ────────────────────────────────────────────────────────────

/** Observed prices older than this are not used for comparisons. */
export const MAX_PRICE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface EligibilityOptions {
  now?: number;
  maxAgeMs?: number;
  /** Allow seeded demo prices (dev builds only). */
  includeDemo?: boolean;
}

export type IneligibleReason =
  | 'expired'
  | 'stale'
  | 'demo'
  | 'not_on_sale'
  | 'variant_mismatch';

function isOnSale(pr: PriceResult): boolean {
  if (pr.source.tier === 'flyer') return true;
  return !!pr.saleInfo?.isOnSale && pr.saleInfo.unitPriceVsRegular <= 0;
}

/** Why `pr` cannot be used for `item`, or null when it can. */
export function ineligibleReason(
  pr: PriceResult,
  item: Pick<BasketItem, 'name' | 'notes'>,
  opts: EligibilityOptions = {},
): IneligibleReason | null {
  const now = opts.now ?? Date.now();
  if (pr.validTo !== undefined && pr.validTo < now) return 'expired';
  if (now - pr.timestamp > (opts.maxAgeMs ?? MAX_PRICE_AGE_MS)) return 'stale';
  if (pr.isDemo && !opts.includeDemo) return 'demo';

  const c = parseItemConstraints(item);
  if (c.saleOnly && !isOnSale(pr)) return 'not_on_sale';

  if (pr.matchedName !== undefined) {
    const product = new Set(extractKeywords(pr.matchedName));
    if (!c.requiredTokens.every((t) => product.has(t))) return 'variant_mismatch';
  } else if (c.noteTokens.length > 0) {
    // The lookup was by item name, so the name's own words are implied —
    // but a note's extra requirement can't be verified without a product name.
    return 'variant_mismatch';
  }
  return null;
}

export function isEligiblePrice(
  pr: PriceResult,
  item: Pick<BasketItem, 'name' | 'notes'>,
  opts: EligibilityOptions = {},
): boolean {
  return ineligibleReason(pr, item, opts) === null;
}

/** Drop every price that can't be used for its item. Stores left empty are removed. */
export function filterEligiblePrices(
  items: BasketItem[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
  opts: EligibilityOptions = {},
): Record<string, Record<string, PriceResult>> {
  const out: Record<string, Record<string, PriceResult>> = {};
  for (const [storeId, prices] of Object.entries(perStorePrices)) {
    const kept: Record<string, PriceResult> = {};
    for (const item of items) {
      const pr = prices[item.id];
      if (pr && isEligiblePrice(pr, item, opts)) kept[item.id] = pr;
    }
    if (Object.keys(kept).length > 0) out[storeId] = kept;
  }
  return out;
}

// ─── Quantity math ──────────────────────────────────────────────────────────

type Dimension = 'count' | 'mass' | 'volume';

/** unit → [dimension, size in base unit (each, g, mL)] */
const UNITS: Record<string, [Dimension, number]> = {
  each: ['count', 1], ea: ['count', 1], pc: ['count', 1], pcs: ['count', 1],
  unit: ['count', 1], units: ['count', 1], ct: ['count', 1],
  g: ['mass', 1], gram: ['mass', 1], grams: ['mass', 1], kg: ['mass', 1000],
  lb: ['mass', 453.592], lbs: ['mass', 453.592], oz: ['mass', 28.3495],
  ml: ['volume', 1], l: ['volume', 1000], litre: ['volume', 1000], liter: ['volume', 1000],
};

function parseUnit(unit: string | undefined): [Dimension, number] | null {
  return UNITS[(unit ?? '').trim().toLowerCase()] ?? null;
}

export interface LineCost {
  cost: number;
  /** True when the quantity couldn't be reconciled with the price's unit. */
  quantityAssumed: boolean;
}

/**
 * What it costs to buy `item` at price `pr`.
 *
 *  - No unit / a package word ("bag", "carton") → quantity is a package count.
 *  - Same dimension with a package size → whole packages (2 L of a 4 L jug = 1 jug).
 *  - Same dimension, no package size → `pr.price` is a rate per `pr.unit`.
 *  - Different dimensions → one package, flagged as assumed.
 */
export function lineCost(item: Pick<BasketItem, 'quantity' | 'unit'>, pr: PriceResult): LineCost {
  const qty = item.quantity > 0 ? item.quantity : 1;
  const itemUnit = parseUnit(item.unit);
  if (!itemUnit) return { cost: pr.price * qty, quantityAssumed: false };

  const priceUnit = parseUnit(pr.unit);
  if (!priceUnit || priceUnit[0] !== itemUnit[0]) {
    if (itemUnit[0] === 'count' && !priceUnit) {
      return { cost: pr.price * qty, quantityAssumed: false };
    }
    return { cost: pr.price, quantityAssumed: true };
  }

  const needed = qty * itemUnit[1];
  if (pr.packageSize && pr.packageSize > 0) {
    const packageBase = pr.packageSize * priceUnit[1];
    // Small epsilon so 1000 mL of a 1 L carton is 1 carton, not 2.
    return { cost: Math.ceil(needed / packageBase - 1e-9) * pr.price, quantityAssumed: false };
  }
  return { cost: pr.price * (needed / priceUnit[1]), quantityAssumed: false };
}

// ─── Plan evaluation ────────────────────────────────────────────────────────

export interface LineAssignment {
  itemId: string;
  storeId: string;
  price: PriceResult;
  cost: number;
  quantityAssumed: boolean;
}

export interface StoreSetEvaluation {
  /** itemId → where it's bought and what it costs */
  assignments: Record<string, LineAssignment>;
  /** Item IDs no store in the set can supply */
  missing: string[];
  total: number;
}

/** Buy each item at whichever store in `storeIds` has the cheapest line. */
export function evaluateStores(
  items: BasketItem[],
  storeIds: string[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
): StoreSetEvaluation {
  const assignments: Record<string, LineAssignment> = {};
  const missing: string[] = [];
  let total = 0;

  for (const item of items) {
    let best: LineAssignment | null = null;
    for (const storeId of storeIds) {
      const pr = perStorePrices[storeId]?.[item.id];
      if (!pr) continue;
      const line = lineCost(item, pr);
      if (!best || line.cost < best.cost) {
        best = { itemId: item.id, storeId, price: pr, ...line };
      }
    }
    if (best) {
      assignments[item.id] = best;
      total += best.cost;
    } else {
      missing.push(item.id);
    }
  }
  return { assignments, missing, total };
}

/** Coverage first: more items covered wins; cost breaks ties. */
export function isBetterPlan(
  a: { missing: unknown[]; total: number },
  b: { missing: unknown[]; total: number },
): boolean {
  return a.missing.length < b.missing.length ||
    (a.missing.length === b.missing.length && a.total < b.total);
}

/**
 * Savings of `plan` vs `baseline`, or null when they don't cover the same
 * items — a lower total that buys fewer things is not a saving.
 */
export function comparableSavings(
  plan: { missing: string[]; total: number },
  baseline: { missing: string[]; total: number },
): number | null {
  if (plan.missing.length !== baseline.missing.length) return null;
  const planMissing = new Set(plan.missing);
  if (!baseline.missing.every((id) => planMissing.has(id))) return null;
  return Math.max(0, baseline.total - plan.total);
}

// ─── Evidence ───────────────────────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  official: 'Store',
  flyer: 'Flyer',
  crowd: 'Crowd',
  scraping: 'Web',
};

/**
 * Short provenance label for a price, e.g. "Flyer · ends Oct 9",
 * "Crowd · 3d ago", "Demo" — so a seeded or old price never reads as a
 * current shelf price.
 */
export function describeEvidence(pr: PriceResult, now: number = Date.now()): string {
  if (pr.isDemo) return 'Demo';
  const tier = TIER_LABELS[pr.source.tier] ?? pr.source.tier;
  if (pr.validTo !== undefined) {
    const end = new Date(pr.validTo);
    return `${tier} · ends ${end.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
  }
  const days = Math.floor((now - pr.timestamp) / (24 * 60 * 60 * 1000));
  return `${tier} · ${days <= 0 ? 'today' : `${days}d ago`}`;
}
