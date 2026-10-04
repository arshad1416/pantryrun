/**
 * Basket — the single source of truth for what a price comparison covers.
 *
 * Every surface that shows a total (store pills, route cards, route
 * sections, Plan My Trip) goes through this module so they agree on:
 *
 *  - which items are in the basket (unchecked, not deleted, this list)
 *  - which prices are eligible for an item (not expired, not stale, not
 *    demo/fixture data, in stock, no unmet membership condition, matching
 *    the requested variant and any "sale only" note)
 *  - whether a match is exact, an allowed substitute, rejected or unresolved
 *  - what a line costs (whole packages for measured quantities)
 *  - which items are held (sale only, no qualifying sale) rather than missing
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

/**
 * How far a match may stray from the words on the list.
 *  - 'exact': every product word must be in the matched name (default)
 *  - 'similar': a product missing some ordinary words may stand in, but
 *    never one missing a hard variant word (see `hardTokens`)
 */
export type SubstitutionPolicy = 'exact' | 'similar';

export interface ItemConstraints {
  /** Tokens that must all appear in the matched product name for an exact match. */
  requiredTokens: string[];
  /**
   * Variant words a substitute may never drop: CAPITALISED emphasis
   * ("GREEN grapes"), expanded abbreviations ("LF" → lactose free) and
   * note requirements ("must be X").
   */
  hardTokens: string[];
  /** Tokens that only a note demanded — unverifiable without a matched name. */
  noteTokens: string[];
  saleOnly: boolean;
  substitution: SubstitutionPolicy;
  /** Text kept for the shopper but not used to match ("for kids", "Oct 25"). */
  context: string[];
}

export const SALE_ONLY_RE = /\b(sale only|only (if )?on sale|on sale only|if on sale|when on sale)\b/i;
export const SUBSTITUTE_RE = /\b(any brand|or similar|substitutes? (ok|okay|fine|allowed)|sub ok)\b/i;
const NOTE_REQUIREMENT_RES = [
  /\bmust be ([a-z0-9 -]+)/i,
  /\bonly ([a-z0-9 -]+)/i,
  /\b([a-z0-9-]+) only\b/i,
];
/** Who or what the item is for — context, never a product constraint. */
const PURPOSE_RE = /\s+(for\s+.+)$/i;

/** Grocery shorthand → words a product name spells out. */
const ABBREVIATIONS: Record<string, string> = {
  lf: 'lactose free',
  gf: 'gluten free',
};

/**
 * Names retailers use for the same product → one canonical phrase, applied
 * to both the list item and the matched product. Whole phrases only: "mini"
 * alone is too generic ("mini pretzels") to be a synonym for anything.
 */
const PRODUCT_SYNONYMS: [RegExp, string][] = [
  [/\b(?:mini|baby)[\s-]+carrots?\b/gi, 'baby carrots'],
];

function canonicaliseProduct(text: string): string {
  return PRODUCT_SYNONYMS.reduce((out, [re, canonical]) => out.replace(re, canonical), text);
}

function expandAbbreviations(text: string): { text: string; expanded: string[] } {
  const expanded: string[] = [];
  const out = text.replace(/\b[a-z]{2}\b/gi, (word) => {
    const full = ABBREVIATIONS[word.toLowerCase()];
    if (!full) return word;
    expanded.push(...extractKeywords(full));
    return full;
  });
  return { text: out, expanded };
}

/** Words written in capitals inside a mixed-case name ("GREEN seedless grapes"). */
function emphasisedTokens(name: string): string[] {
  if (name === name.toUpperCase()) return []; // all caps carries no emphasis
  return name
    .split(/[^A-Za-z0-9-]+/)
    .filter((w) => w.length >= 2 && /[A-Z]/.test(w) && w === w.toUpperCase())
    .flatMap((w) => extractKeywords(w));
}

/**
 * Read the shopping rules a person wrote on an item. Grammar is deliberately
 * small: the item name's own words (with shorthand like "LF" expanded),
 * capitalised words as hard variants, "sale only" style phrases,
 * "must be X" / "only X" / "X only" in notes, and "any brand" / "or similar"
 * to allow substitutes. A trailing "for …" ("for kids") is context only — it
 * never becomes a product requirement or a dietary rule.
 */
export function parseItemConstraints(item: Pick<BasketItem, 'name' | 'notes'>): ItemConstraints {
  const context: string[] = [];
  let name = item.name ?? '';
  const purpose = name.match(PURPOSE_RE);
  if (purpose) {
    context.push(purpose[1].trim());
    name = name.slice(0, purpose.index).trim();
  }

  const { text: expandedName, expanded } = expandAbbreviations(canonicaliseProduct(name));
  const hardTokens = emphasisedTokens(expandedName);
  const nameTokens = extractKeywords(expandedName);
  for (const t of expanded) if (!hardTokens.includes(t)) hardTokens.push(t);

  const notes = item.notes ?? '';
  const saleOnly = SALE_ONLY_RE.test(notes);
  const substitution: SubstitutionPolicy = SUBSTITUTE_RE.test(notes) ? 'similar' : 'exact';

  const noteTokens: string[] = [];
  const remaining = notes.replace(SALE_ONLY_RE, ' ').replace(SUBSTITUTE_RE, ' ');
  let leftover = remaining;
  for (const re of NOTE_REQUIREMENT_RES) {
    const m = remaining.match(re);
    if (!m?.[1]) continue;
    leftover = leftover.replace(m[0], ' ');
    for (const t of extractKeywords(expandAbbreviations(m[1]).text)) {
      if (t !== 'sale' && !nameTokens.includes(t) && !noteTokens.includes(t)) {
        noteTokens.push(t);
      }
    }
  }
  for (const t of noteTokens) if (!hardTokens.includes(t)) hardTokens.push(t);
  const note = leftover.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').replace(/\s+/g, ' ');
  if (note) context.push(note);

  return {
    requiredTokens: [...nameTokens, ...noteTokens],
    hardTokens,
    noteTokens,
    saleOnly,
    substitution,
    context,
  };
}

// ─── Matching ───────────────────────────────────────────────────────────────

/**
 * How an offer's product relates to the requested item:
 *  - 'exact': every requested word is in the product name
 *  - 'substitute': an allowed stand-in under a 'similar' policy
 *  - 'rejected': the product names a conflicting variant (red vs green)
 *    or drops a hard variant word
 *  - 'unresolved': the evidence doesn't say either way ("Beef patties" for
 *    Jamaican patties) — not proof the constraint is met
 */
export type MatchStatus = 'exact' | 'substitute' | 'rejected' | 'unresolved';

/** Mutually exclusive variant words — a product with one excludes the others. */
const VARIANT_FAMILIES: string[][] = [
  ['red', 'green', 'black', 'white', 'yellow', 'orange', 'purple', 'cotton'],
  ['seedless', 'seeded'],
];

function conflicts(required: string[], product: Set<string>): boolean {
  return VARIANT_FAMILIES.some((family) =>
    required.some((t) => family.includes(t) && !product.has(t) &&
      family.some((other) => other !== t && product.has(other))),
  );
}

export function classifyMatch(
  pr: Pick<PriceResult, 'matchedName'>,
  item: Pick<BasketItem, 'name' | 'notes'>,
): MatchStatus {
  const c = parseItemConstraints(item);
  if (pr.matchedName === undefined) {
    // The lookup was by item name, so the name's own words are implied —
    // but a note's extra requirement can't be verified without a product name.
    return c.noteTokens.length > 0 ? 'unresolved' : 'exact';
  }
  const product = new Set(
    extractKeywords(expandAbbreviations(canonicaliseProduct(pr.matchedName)).text),
  );
  const missing = c.requiredTokens.filter((t) => !product.has(t));
  if (missing.length === 0) return 'exact';
  if (conflicts(c.requiredTokens, product)) return 'rejected';
  if (c.substitution === 'similar') {
    // A stand-in may drop ordinary words, never a hard variant word.
    if (missing.some((t) => c.hardTokens.includes(t))) return 'rejected';
    const head = c.requiredTokens.filter((t) => !c.noteTokens.includes(t)).pop();
    if (head !== undefined && product.has(head)) return 'substitute';
  }
  return 'unresolved';
}

// ─── Eligibility ────────────────────────────────────────────────────────────

/** Observed prices older than this are not used for comparisons. */
export const MAX_PRICE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface EligibilityOptions {
  now?: number;
  maxAgeMs?: number;
  /** Allow seeded demo prices (dev builds only). */
  includeDemo?: boolean;
  /** Allow synthetic fixture prices (tests only). */
  includeFixtures?: boolean;
  /** Conditions the shopper has, e.g. ['Costco membership']. */
  memberships?: string[];
}

export type IneligibleReason =
  | 'expired'
  | 'stale'
  | 'demo'
  | 'unavailable'
  | 'membership_required'
  | 'not_on_sale'
  | 'variant_mismatch'
  | 'unresolved_match';

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
  if (pr.isFixture && !opts.includeFixtures) return 'demo';
  if (pr.stock === 'out_of_stock') return 'unavailable';
  if (pr.membership && !(opts.memberships ?? []).includes(pr.membership)) {
    return 'membership_required';
  }

  if (parseItemConstraints(item).saleOnly && !isOnSale(pr)) return 'not_on_sale';

  const match = classifyMatch(pr, item);
  if (match === 'rejected') return 'variant_mismatch';
  if (match === 'unresolved') return 'unresolved_match';
  return null;
}

export function isEligiblePrice(
  pr: PriceResult,
  item: Pick<BasketItem, 'name' | 'notes'>,
  opts: EligibilityOptions = {},
): boolean {
  return ineligibleReason(pr, item, opts) === null;
}

/** A sale-only item with no qualifying sale is held, not bought at regular price. */
export function isSaleOnlyHold(item: Pick<BasketItem, 'name' | 'notes'>): boolean {
  return parseItemConstraints(item).saleOnly;
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
  /** Checkout line total. */
  cost: number;
  /** True when the quantity couldn't be reconciled with the price's unit. */
  quantityAssumed: boolean;
  /** Fixed packages to put in the cart; absent for loose, priced-by-weight goods. */
  packages?: number;
  /** What actually goes home, in the price's unit (≥ the requested amount). */
  purchased: { amount: number; unit: string };
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
  const packagesOf = (n: number): LineCost => ({
    cost: pr.price * n,
    quantityAssumed: false,
    packages: n,
    purchased: pr.packageSize
      ? { amount: pr.packageSize * n, unit: pr.unit }
      : { amount: n, unit: pr.unit || 'each' },
  });

  const itemUnit = parseUnit(item.unit);
  if (!itemUnit) return packagesOf(qty);

  const priceUnit = parseUnit(pr.unit);
  if (!priceUnit || priceUnit[0] !== itemUnit[0]) {
    if (itemUnit[0] === 'count' && !priceUnit) return packagesOf(qty);
    return { ...packagesOf(1), quantityAssumed: true };
  }

  const needed = qty * itemUnit[1];
  if (pr.packageSize && pr.packageSize > 0) {
    const packageBase = pr.packageSize * priceUnit[1];
    // Small epsilon so 1000 mL of a 1 L carton is 1 carton, not 2.
    return packagesOf(Math.ceil(needed / packageBase - 1e-9));
  }
  const amount = needed / priceUnit[1];
  return {
    cost: pr.price * amount,
    quantityAssumed: false,
    purchased: { amount, unit: pr.unit },
  };
}

/** Round to cents — totals are summed from rounded checkout lines. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Plan evaluation ────────────────────────────────────────────────────────

export interface LineAssignment extends LineCost {
  itemId: string;
  storeId: string;
  price: PriceResult;
  /** 'substitute' lines are allowed stand-ins, not the requested product. */
  match: MatchStatus;
}

export interface StoreSetEvaluation {
  /** itemId → where it's bought and what it costs */
  assignments: Record<string, LineAssignment>;
  /** Item IDs no store in the set can supply (includes `held`) */
  missing: string[];
  /** Sale-only items with no qualifying sale — deliberately not bought, not a gap. */
  held: string[];
  total: number;
}

/**
 * Buy each item at whichever store in `storeIds` has the cheapest line.
 * Prices must already be eligibility-filtered (`filterEligiblePrices`).
 */
export function evaluateStores(
  items: BasketItem[],
  storeIds: string[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
): StoreSetEvaluation {
  const assignments: Record<string, LineAssignment> = {};
  const missing: string[] = [];
  const held: string[] = [];
  let total = 0;

  for (const item of items) {
    let best: LineAssignment | null = null;
    for (const storeId of storeIds) {
      const pr = perStorePrices[storeId]?.[item.id];
      if (!pr) continue;
      const line = lineCost(item, pr);
      line.cost = cents(line.cost);
      if (!best || line.cost < best.cost) {
        best = { itemId: item.id, storeId, price: pr, match: classifyMatch(pr, item), ...line };
      }
    }
    if (best) {
      assignments[item.id] = best;
      total += best.cost;
    } else {
      missing.push(item.id);
      if (isSaleOnlyHold(item)) held.push(item.id);
    }
  }
  return { assignments, missing, held, total: cents(total) };
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
 * What kind of evidence a price is:
 *  - 'verified': read from a retailer source (store site, flyer) and current
 *  - 'manual': typed in or crowd-submitted — unverified
 *  - 'demo' / 'fixture': seeded or synthetic, never a shelf price
 *  - 'expired' / 'stale': past its end date or too old to use
 *  - 'unavailable': observed out of stock
 */
export type EvidenceStatus =
  | 'verified'
  | 'manual'
  | 'demo'
  | 'fixture'
  | 'expired'
  | 'stale'
  | 'unavailable';

export function evidenceStatus(
  pr: PriceResult,
  now: number = Date.now(),
  maxAgeMs: number = MAX_PRICE_AGE_MS,
): EvidenceStatus {
  if (pr.isDemo) return 'demo';
  if (pr.isFixture) return 'fixture';
  if (pr.validTo !== undefined && pr.validTo < now) return 'expired';
  if (now - pr.timestamp > maxAgeMs) return 'stale';
  if (pr.stock === 'out_of_stock') return 'unavailable';
  return pr.source.tier === 'crowd' ? 'manual' : 'verified';
}

/**
 * Short provenance label for a price, e.g. "Flyer · ends Oct 9",
 * "Crowd · 3d ago", "Demo" — so a seeded or old price never reads as a
 * current shelf price.
 */
export function describeEvidence(pr: PriceResult, now: number = Date.now()): string {
  if (pr.isDemo) return 'Demo';
  if (pr.isFixture) return 'Test data';
  const tier = TIER_LABELS[pr.source.tier] ?? pr.source.tier;
  let label: string;
  if (pr.validTo !== undefined) {
    const end = new Date(pr.validTo);
    label = `${tier} · ends ${end.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
  } else {
    const days = Math.floor((now - pr.timestamp) / (24 * 60 * 60 * 1000));
    label = `${tier} · ${days <= 0 ? 'today' : `${days}d ago`}`;
  }
  return pr.membership ? `${label} · ${pr.membership} price` : label;
}
