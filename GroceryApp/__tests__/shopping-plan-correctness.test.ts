/**
 * Shopping-plan correctness — the required acceptance cases A–F.
 *
 *  A. Coverage and claims        D. Optimization (exact solver vs. oracle)
 *  B. Intent and matching        E. Time and evidence
 *  C. Quantity math              F. Refresh and races
 *
 * Fixture: __tests__/fixtures/waterdown-oct-2026.ts (reconstructed — see its
 * header). Clock pinned to 4 Oct 2026, America/Toronto. G (import) lives in
 * checklist-import.test.ts.
 *
 * Run: npx jest __tests__/shopping-plan-correctness.test.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  analyzeBasket,
  compareSavings,
  planForStores,
  selectBasketItems,
  solvePlan,
  type BasketItem,
  type BasketPlan,
  type PlanContext,
  type StoreOffers,
} from '../src/pricing/basket';
import { assessOffer, localDate, startOfLocalDay } from '../src/pricing/eligibility';
import { checkVariant, parseItemIntent } from '../src/pricing/intent';
import { parseRequirement, purchaseFor, quantityStatus, type Requirement } from '../src/pricing/quantity';
import { computeStopProposals } from '../src/pricing/stop-optimizer';
import { computeTripPlan } from '../src/pricing/trip-plan';
import type { PriceResult } from '../src/pricing/types';
import {
  BASKET,
  OCT_26_NOON,
  OCT_8_NOON,
  PINNED_NOW,
  STORE_NAMES,
  TZ,
  buildOffers,
  fixtureContext,
  offer,
} from './fixtures/waterdown-oct-2026';

// ─── Mocks for the price-store race tests (F) ───────────────────────────────

jest.mock('../src/config/settings', () => ({
  getSettings: () => ({ pricingOptedIn: true }),
}));
jest.mock('../src/pricing/registry', () => ({
  priceRegistry: { getAllPrices: jest.fn(), getPrice: jest.fn() },
}));
jest.mock('../src/pricing/crowdsourced', () => ({ crowdsourcedAdapter: {} }));

// eslint-disable-next-line import/first
import { usePriceStore } from '../src/pricing/price-store';
// eslint-disable-next-line import/first
import { priceRegistry } from '../src/pricing/registry';

// ─── Helpers ────────────────────────────────────────────────────────────────

function plan(maxStops: number, ctx: PlanContext = fixtureContext(), items = BASKET, offers = buildOffers()): BasketPlan {
  return solvePlan(analyzeBasket(items, offers, ctx), maxStops, ctx);
}

function line(p: BasketPlan, itemId: string) {
  const l = p.lines.find((x) => x.itemId === itemId);
  if (!l) throw new Error(`no line ${itemId}`);
  return l;
}

function costedIds(p: BasketPlan): string[] {
  return p.lines.filter((l) => l.status === 'costed').map((l) => l.itemId);
}

function req(qty: number | null, unit?: string): Requirement {
  const r = parseRequirement(qty, unit);
  if (!r.ok) throw new Error(r.reason);
  return r.requirement;
}

/** Bare offer for the generic optimization fixtures. */
function simple(price: number, extra: Partial<PriceResult> = {}): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: { adapterId: 'test', tier: 'official', storeId: 'x', storeName: 'x' },
    timestamp: PINNED_NOW,
    confidence: 'real_time',
    ...extra,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// A. Coverage and claims
// ════════════════════════════════════════════════════════════════════════════

describe('A. coverage and claims', () => {
  it("Fortinos's two-item $7.88 subtotal never beats the comparable ten-line plan", () => {
    const analysis = analyzeBasket(BASKET, buildOffers(), fixtureContext());
    const fortinos = planForStores(analysis, ['fortinos']);
    expect(costedIds(fortinos).sort()).toEqual(['bread', 'carrots']);
    expect(fortinos.totalCents).toBe(788);
    expect(fortinos.fulfillment).toBe('incomplete');
    expect(fortinos.claim).toBe('none');

    const best = solvePlan(analysis, 3);
    expect(best.costedCount).toBe(10);
    expect(best.storeIds).not.toEqual(['fortinos']);

    // Route cards: the 1-stop card is not Fortinos either, and savings against
    // a Fortinos-only baseline would be unavailable, not "$69 more".
    const proposals = computeStopProposals(BASKET, buildOffers(), STORE_NAMES, 3, fixtureContext());
    expect(proposals[0].stores.map((s) => s.storeId)).toEqual(['no-frills']);
    expect(compareSavings(best, fortinos)).toEqual({ status: 'unavailable', reason: 'different_coverage' });
  });

  it('reports ten costed lines plus one sale-only hold', () => {
    const p = plan(3);
    expect(p.totalCount).toBe(11);
    expect(p.costedCount).toBe(10);
    expect(p.heldCount).toBe(1);
    expect(p.blockedCount).toBe(0);
    expect(line(p, 'ketchup').status).toBe('held');
    expect(line(p, 'ketchup').reasons).toContain('not_on_sale');
    expect(p.fulfillment).toBe('complete_with_holds');
  });

  it('if all 11 are required now, fulfilment is incomplete and no cheapest claim is made', () => {
    const ctx = fixtureContext({ requireHeldItems: true });
    const p = plan(3, ctx);
    expect(p.costedCount).toBe(10);
    expect(p.fulfillment).toBe('incomplete');
    expect(p.claim).toBe('none');
  });

  it('missing prices, unknown quantities and unresolved variants stay visible — never free or dropped', () => {
    const items: BasketItem[] = [
      ...BASKET,
      { id: 'saffron', name: 'saffron', quantity: 1, unit: '' },
      { id: 'flour', name: 'flour', quantity: null, unit: 'kg' },
      { id: 'yogurt', name: 'yogurt', quantity: 1, unit: '', notes: 'greek only' },
    ];
    const offers = buildOffers();
    offers['no-frills'].yogurt = offer('no-frills', 'Plain Yogurt 750 g', 3.49, { unit: 'tub' });
    const p = plan(3, fixtureContext(), items, offers);
    expect(p.totalCount).toBe(14);
    expect(line(p, 'saffron')).toMatchObject({ status: 'unavailable', reasons: ['no_offer'] });
    expect(line(p, 'flour')).toMatchObject({ status: 'quantity_unknown' });
    expect(line(p, 'yogurt')).toMatchObject({ status: 'unavailable', reasons: ['variant_mismatch'] });
    expect(p.totalCents).toBe(7329); // nothing added for them
    expect(p.fulfillment).toBe('incomplete');

    const trip = computeTripPlan(items, offers, 3, undefined, STORE_NAMES, fixtureContext());
    expect(trip.unassigned.map((u) => u.itemId).sort()).toEqual(['flour', 'saffron', 'yogurt']);
    for (const u of trip.unassigned) {
      expect(u.price).toBeNull();
      expect(u.lineTotal).toBeNull();
    }
    expect(trip.held.map((h) => h.itemId)).toEqual(['ketchup']);
  });

  it('an incomplete or differently quantified baseline gives unavailable savings, not $0 or an inflated discount', () => {
    const ctx = fixtureContext();
    const three = plan(3, ctx);
    // Baseline from a different analysis (milk quantity 2 L instead of 3 L)
    const otherItems = BASKET.map((i) => (i.id === 'milk' ? { ...i, quantity: 2 } : i));
    const otherBaseline = plan(2, ctx, otherItems);
    expect(compareSavings(three, otherBaseline)).toEqual({ status: 'unavailable', reason: 'different_assumptions' });
    // Incomplete baseline (Fortinos alone)
    const analysis = analyzeBasket(BASKET, buildOffers(), ctx);
    expect(compareSavings(three, planForStores(analysis, ['fortinos'])).status).toBe('unavailable');
    // No baseline at all
    expect(compareSavings(three, null)).toEqual({ status: 'unavailable', reason: 'no_baseline' });
    // Trip plan: no single store covers the 10 lines → savings null, not 0
    const trip = computeTripPlan(BASKET, buildOffers(), 3, undefined, STORE_NAMES, ctx);
    expect(trip.savings).toBeNull();
    expect(trip.savingsComparable).toBe(false);
  });

  it('a zero saving is reported only when comparable totals really are equal', () => {
    const items: BasketItem[] = [{ id: 'a', name: 'a', quantity: 1, unit: '' }];
    const offers: StoreOffers = { s1: { a: simple(2) }, s2: { a: simple(2) } };
    const analysis = analyzeBasket(items, offers, { now: PINNED_NOW });
    expect(compareSavings(solvePlan(analysis, 2), solvePlan(analysis, 1))).toEqual({ status: 'available', amountCents: 0 });
  });

  it('demo, unknown-source or stale evidence cannot support a verified-cheapest claim', () => {
    const ctx = fixtureContext();
    expect(plan(3, ctx).claim).toBe('verified');

    // Each tampered line is one the plan actually uses (No Frills eggs/mayo/rice).
    const demo = buildOffers();
    (demo['no-frills'].eggs as PriceResult).isDemo = true;
    expect(plan(3, { ...ctx, includeDemo: true }, BASKET, demo).claim).toBe('estimate');
    // Outside dev builds demo prices aren't usable at all: the line is blocked
    expect(line(plan(3, ctx, BASKET, demo), 'eggs')).toMatchObject({ status: 'unavailable', reasons: ['demo'] });

    const unknown = buildOffers();
    (unknown['no-frills'].mayo as PriceResult).source.adapterId = '';
    expect(plan(3, ctx, BASKET, unknown).claim).toBe('estimate');

    const aging = buildOffers();
    (aging['no-frills'].rice as PriceResult).timestamp = PINNED_NOW - 10 * 24 * 3600 * 1000;
    expect(plan(3, ctx, BASKET, aging).claim).toBe('estimate');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Intent and matching
// ════════════════════════════════════════════════════════════════════════════

describe('B. intent and matching', () => {
  it('checked items and explicit zero quantities are excluded from fetch, assignment and totals', () => {
    const rows = BASKET.map((i) => ({ ...i, listId: 'L', isDeleted: false, isChecked: false }));
    rows.find((r) => r.id === 'gummies')!.isChecked = true;
    rows.find((r) => r.id === 'rice')!.quantity = 0;
    const basket = selectBasketItems(rows, 'L');
    expect(basket.map((b) => b.id)).not.toContain('gummies');
    expect(basket.map((b) => b.id)).not.toContain('rice');

    const p = plan(3, fixtureContext(), basket);
    expect(p.totalCount).toBe(9);
    // 73.29 − gummies 11.29 − rice 2.97 = 59.03; Costco no longer a stop
    expect(p.totalCents).toBe(5903);
    expect(p.storeIds).toEqual(['fortinos', 'no-frills']);

    // Unchecking and restoring the quantity recomputes
    rows.find((r) => r.id === 'gummies')!.isChecked = false;
    rows.find((r) => r.id === 'rice')!.quantity = 1;
    expect(plan(3, fixtureContext(), selectBasketItems(rows, 'L')).totalCents).toBe(7329);
  });

  it('LF milk requires lactose-free AND whole/3.25%', () => {
    const intent = parseItemIntent({ name: 'LF milk', notes: '3.25% only' });
    expect(intent.requiredTokens.sort()).toEqual(['lactosefree', 'milk', 'whole']);
    expect(checkVariant(intent, 'Neilson 2% Milk 4 L')).toBe('mismatch');
    expect(checkVariant(intent, 'Lactantia Lactose Free 2% Milk 2 L')).toBe('mismatch');
    expect(checkVariant(intent, 'Lactantia Lactose Free 1% Milk 2 L')).toBe('mismatch');
    expect(checkVariant(intent, 'Natrel Lactose Free 3.25% Milk 2 L')).toBe('match');
    expect(checkVariant(intent, 'Natrel Lactose-Free Homogenized Milk')).toBe('match');
    // The cheaper wrong-fat offers never reach the plan
    const milk = line(plan(3), 'milk');
    expect(milk.option?.offer.matchedName).toBe('Natrel Lactose Free 3.25% Milk 2 L');
  });

  it('red grapes cannot satisfy GREEN seedless grapes', () => {
    const intent = parseItemIntent({ name: 'green seedless grapes' });
    expect(checkVariant(intent, 'Red Seedless Grapes')).toBe('mismatch');
    expect(checkVariant(intent, 'Green Seedless Grapes')).toBe('match');
    expect(line(plan(3), 'grapes').option?.storeId).toBe('no-frills'); // not the $4.40 red
  });

  it('generic patties cannot satisfy JAMAICAN; generic mayo cannot prove garlic', () => {
    expect(checkVariant(parseItemIntent({ name: 'Jamaican patties' }), 'Beef Patties 12 pk')).toBe('mismatch');
    expect(checkVariant(parseItemIntent({ name: 'garlic mayo' }), "Hellmann's Real Mayonnaise")).toBe('mismatch');
    expect(checkVariant(parseItemIntent({ name: 'garlic mayo' }), 'Roasted Garlic Mayonnaise')).toBe('match');
    const p = plan(3);
    expect(line(p, 'patties').option?.storeId).toBe('no-frills');
    expect(line(p, 'mayo').option?.storeId).toBe('no-frills');
  });

  it('substitution permission only admits candidates that keep the hard constraints', () => {
    const exact = parseItemIntent({ name: 'Natrel LF milk' });
    expect(checkVariant(exact, 'Lactantia Lactose Free Milk')).toBe('mismatch'); // brand differs
    const subs = parseItemIntent({ name: 'Natrel LF milk', notes: 'any brand ok' });
    expect(subs.substitution).toBe('substitutes_ok');
    expect(checkVariant(subs, 'Lactantia Lactose Free Milk')).toBe('match');
    expect(checkVariant(subs, 'Neilson Milk')).toBe('mismatch'); // lactose-free retained
    expect(checkVariant(parseItemIntent({ name: 'Heinz ketchup', notes: 'subs ok' }), 'Compliments Ketchup')).toBe('match');
  });

  it('changing the substitution policy invalidates the match and the plan fingerprint', () => {
    const offers: StoreOffers = { s1: { k: simple(3, { matchedName: 'Compliments Ketchup' }) } };
    const exactItems: BasketItem[] = [{ id: 'k', name: 'Heinz ketchup', quantity: 1, unit: '' }];
    const subsItems: BasketItem[] = [{ ...exactItems[0], notes: 'any brand ok' }];
    const a = analyzeBasket(exactItems, offers, { now: PINNED_NOW });
    const b = analyzeBasket(subsItems, offers, { now: PINNED_NOW });
    expect(solvePlan(a, 1).costedCount).toBe(0);
    expect(solvePlan(b, 1).costedCount).toBe(1);
    expect(a.contextKey).not.toBe(b.contextKey);
  });

  it('ketchup is held without a qualifying sale', () => {
    const k = line(plan(3), 'ketchup');
    expect(k.status).toBe('held');
    expect(k.option).toBeUndefined();
  });

  it("Cascade's sale-only rule rejects an expired sale; the full-price offer does not replace it", () => {
    const after = plan(3, fixtureContext({ now: OCT_8_NOON }));
    const c = line(after, 'cascade');
    expect(c.status).toBe('held');
    expect(c.reasons).toEqual(expect.arrayContaining(['expired', 'not_on_sale']));
    // The $13.99 Fortinos regular price was never used
    expect(after.lines.some((l) => l.option?.offer.price === 13.99)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Quantity math
// ════════════════════════════════════════════════════════════════════════════

describe('C. quantity math', () => {
  it('500 g from 340 g bags at $2.99 = 2 bags, $5.98, 680 g purchased', () => {
    const r = purchaseFor(req(500, 'g'), offer('fortinos', 'Baby Carrots 340 g', 2.99, { unit: 'g', packageSize: 340 }));
    expect(r).toMatchObject({ ok: true, purchase: { costCents: 598, packages: 2, purchasedLabel: '680 g' } });
  });

  it('3 L from 2 L cartons at $6.25 = 2 cartons, $12.50', () => {
    const r = purchaseFor(req(3, 'L'), offer('no-frills', 'LF 3.25% 2 L', 6.25, { unit: 'L', packageSize: 2 }));
    expect(r).toMatchObject({ ok: true, purchase: { costCents: 1250, packages: 2, purchasedLabel: '4 L' } });
  });

  it('1.5 kg of weighed grapes at $6.59/kg = $9.89 (half-up to the cent), not two 1 kg packs', () => {
    const r = purchaseFor(req(1.5, 'kg'), offer('no-frills', 'Green Seedless Grapes', 6.59, { unit: 'kg', pricingBasis: 'measure' }));
    expect(r).toMatchObject({ ok: true, purchase: { costCents: 989, packages: null, purchasedLabel: '1.5 kg' } });
    // grams convert to the per-kg rate
    expect(purchaseFor(req(1500, 'g'), offer('x', 'g', 6.59, { unit: 'kg', pricingBasis: 'measure' })))
      .toMatchObject({ ok: true, purchase: { costCents: 989 } });
  });

  it('missing quantity is unknown, negative/invalid is rejected, zero is preserved', () => {
    expect(quantityStatus(null)).toBe('unknown');
    expect(quantityStatus(undefined)).toBe('unknown');
    expect(quantityStatus(-2)).toBe('invalid');
    expect(quantityStatus(Number.NaN)).toBe('invalid');
    expect(quantityStatus(Infinity)).toBe('invalid');
    expect(quantityStatus(0)).toBe('zero');
    expect(parseRequirement(null, 'kg')).toEqual({ ok: false, reason: 'quantity_unknown' });
    expect(parseRequirement(-1, 'kg')).toEqual({ ok: false, reason: 'quantity_invalid' });
    expect(parseRequirement(0, 'kg')).toEqual({ ok: false, reason: 'quantity_zero' });
    const p = plan(1, { now: PINNED_NOW }, [{ id: 'x', name: 'x', quantity: -3, unit: '' }], { s: { x: simple(2) } });
    expect(line(p, 'x').status).toBe('quantity_invalid');
    expect(p.totalCents).toBe(0);
  });

  it('count/volume/mass mismatches and missing pack sizes are explicit, never guessed', () => {
    expect(purchaseFor(req(2, 'L'), simple(3))).toEqual({ ok: false, reason: 'unit_incompatible' });
    expect(purchaseFor(req(6, 'pcs'), simple(5, { unit: 'kg', pricingBasis: 'measure' }))).toEqual({ ok: false, reason: 'unit_incompatible' });
    expect(purchaseFor(req(500, 'g'), simple(3, { unit: 'bag' }))).toEqual({ ok: false, reason: 'pack_size_unknown' });
    expect(purchaseFor(req(1, 'bunch'), simple(0.69, { unit: 'lb', pricingBasis: 'measure' }))).toEqual({ ok: false, reason: 'unit_incompatible' });
    expect(parseRequirement(2, 'handful')).toEqual({ ok: false, reason: 'unit_unknown' });
  });

  it('a crowd "1 bag" price buys bags; "3 bags" for one price is ambiguous', () => {
    expect(purchaseFor(req(2, 'bag'), simple(1.99, { unit: 'bag', packageSize: 1 })))
      .toMatchObject({ ok: true, purchase: { costCents: 398, packages: 2 } });
    expect(purchaseFor(req(2, 'bag'), simple(4.99, { unit: 'bag', packageSize: 3 }))).toEqual({ ok: false, reason: 'pack_size_unknown' });
  });

  it('a shelf unit price is not substituted for the cost of the required packages', () => {
    // "$8.80 /kg" shelf label with no pack size or basis: ambiguous, not costed as 0.5 × 8.80
    expect(purchaseFor(req(500, 'g'), simple(8.8, { unit: 'kg' }))).toEqual({ ok: false, reason: 'pack_size_unknown' });
  });

  it('multi-buy terms are applied as stated', () => {
    const twoForFive = { groupSize: 2, groupPrice: 5, requiresFullGroup: true };
    expect(purchaseFor(req(3, ''), simple(2.99, { multiBuy: twoForFive })))
      .toMatchObject({ ok: true, purchase: { costCents: 1000, packages: 4 } });
    expect(purchaseFor(req(3, ''), simple(2.99, { multiBuy: { ...twoForFive, requiresFullGroup: false } })))
      .toMatchObject({ ok: true, purchase: { costCents: 799, packages: 3 } });
  });

  it('per-customer limits use the regular price beyond the limit, or reject when it is unknown', () => {
    const sale = { isOnSale: true, salePrice: 2.49, regularPrice: 3.49, saleEndDate: null, unitPriceVsRegular: -1, savingsPercent: 29 };
    expect(purchaseFor(req(3, ''), simple(2.49, { limitPerCustomer: 2, saleInfo: sale })))
      .toMatchObject({ ok: true, purchase: { costCents: 847 } });
    expect(purchaseFor(req(3, ''), simple(2.49, { limitPerCustomer: 2 }))).toEqual({ ok: false, reason: 'exceeds_limit' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Optimization
// ════════════════════════════════════════════════════════════════════════════

/** Independent oracle: every item→store assignment within the stop cap. */
function oracle(items: { id: string; quantity: number }[], prices: Record<string, Record<string, number>>, k: number) {
  const stores = Object.keys(prices).sort();
  let best: { covered: number; cents: number; stops: string[] } | null = null;
  const choose = (i: number, used: Set<string>, covered: number, cents: number) => {
    if (i === items.length) {
      const stops = [...used].sort();
      const cand = { covered, cents, stops };
      const better = !best ||
        cand.covered > best.covered ||
        (cand.covered === best.covered && (cand.cents < best.cents ||
          (cand.cents === best.cents && (cand.stops.length < best.stops.length ||
            (cand.stops.length === best.stops.length && cand.stops.join('\u0000') < best.stops.join('\u0000'))))));
      if (better) best = cand;
      return;
    }
    choose(i + 1, used, covered, cents); // leave uncovered
    for (const s of stores) {
      const p = prices[s][items[i].id];
      if (p === undefined) continue;
      if (!used.has(s) && used.size >= k) continue;
      const next = new Set(used).add(s);
      choose(i + 1, next, covered + 1, cents + Math.round(p * 100) * items[i].quantity);
    }
  };
  choose(0, new Set(), 0, 0);
  return best!;
}

function toOffers(prices: Record<string, Record<string, number>>): StoreOffers {
  const out: StoreOffers = {};
  for (const [s, items] of Object.entries(prices)) {
    out[s] = Object.fromEntries(Object.entries(items).map(([id, p]) => [id, simple(p)]));
  }
  return out;
}

/** Deterministic PRNG (mulberry32) for generated fixtures. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('D. optimization', () => {
  it('pinned fixture: $77.20 at ≤2 stores, $73.29 at ≤3, exactly $3.91 apart with the same coverage', () => {
    const ctx = fixtureContext();
    const analysis = analyzeBasket(BASKET, buildOffers(), ctx);
    const two = solvePlan(analysis, 2, ctx);
    const three = solvePlan(analysis, 3, ctx);
    expect(two.totalCents).toBe(7720);
    expect(three.totalCents).toBe(7329);
    expect(two.storeIds).toEqual(['costco', 'no-frills']);
    expect(three.storeIds).toEqual(['costco', 'fortinos', 'no-frills']);
    expect(costedIds(two)).toEqual(costedIds(three));
    expect(compareSavings(three, two)).toEqual({ status: 'available', amountCents: 391 });
    // Fortinos' stop in the 3-store plan: carrots + bread = $7.88
    const fortinosCents = three.lines
      .filter((l) => l.option?.storeId === 'fortinos')
      .reduce((s, l) => s + l.option!.purchase.costCents, 0);
    expect(fortinosCents).toBe(788);
  });

  it('a 4-store cap may use A1 for rice; the 2/3-store caps are respected', () => {
    const p4 = plan(4);
    expect(p4.storeIds).toHaveLength(4);
    expect(p4.totalCents).toBe(7281);
    expect(plan(2).storeIds.length).toBeLessThanOrEqual(2);
    expect(plan(3).storeIds.length).toBeLessThanOrEqual(3);
  });

  it('each item cheapest at a different store (4 stores) — caps hold and match the oracle', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, quantity: 1, unit: '' }));
    const prices = {
      s1: { a: 1, b: 5, c: 5, d: 5 },
      s2: { a: 5, b: 1, c: 5, d: 5 },
      s3: { a: 5, b: 5, c: 1, d: 5 },
      s4: { a: 5, b: 5, c: 5, d: 1 },
      gen: { a: 3, b: 3, c: 3, d: 3 },
    };
    const analysis = analyzeBasket(items, toOffers(prices), { now: PINNED_NOW });
    for (const k of [1, 2, 3]) {
      const p = solvePlan(analysis, k);
      const o = oracle(items, prices, k);
      expect(p.storeIds.length).toBeLessThanOrEqual(k);
      expect([p.costedCount, p.totalCents, p.storeIds]).toEqual([o.covered, o.cents, o.stops]);
    }
    // Per-item cheapest would need all 4 specialists for $4.00. Under a
    // 2-store cap the optimum is the generalist + one specialist: 1 + 3 × 3.
    expect(solvePlan(analysis, 2).totalCents).toBe(1000);
    expect(solvePlan(analysis, 2).storeIds).toEqual(['gen', 's1']);
    expect(solvePlan(analysis, 3).totalCents).toBe(800); // gen + 2 specialists: 1 + 1 + 3 + 3
  });

  it('matches the exhaustive oracle on 60 generated fixtures (gaps, ties, caps 1–3)', () => {
    const rand = rng(20261004);
    for (let f = 0; f < 60; f++) {
      const nItems = 3 + Math.floor(rand() * 3);
      const nStores = 3 + Math.floor(rand() * 3);
      const items = Array.from({ length: nItems }, (_, i) => ({
        id: `i${i}`, name: `i${i}`, quantity: 1 + Math.floor(rand() * 3), unit: '',
      }));
      const prices: Record<string, Record<string, number>> = {};
      for (let s = 0; s < nStores; s++) {
        prices[`s${s}`] = {};
        for (const it of items) {
          if (rand() < 0.3) continue; // gaps
          prices[`s${s}`][it.id] = 1 + Math.floor(rand() * 4) / 2; // coarse → frequent ties
        }
      }
      const analysis = analyzeBasket(items, toOffers(prices), { now: PINNED_NOW });
      for (const k of [1, 2, 3]) {
        const p = solvePlan(analysis, k);
        const o = oracle(items, prices, k);
        expect([f, k, p.costedCount, p.totalCents, p.storeIds]).toEqual([f, k, o.covered, o.cents, o.stops]);
      }
    }
  });

  it('a single store that covers everything is returned under an "at most" cap', () => {
    const items = [{ id: 'a', name: 'a', quantity: 1, unit: '' }, { id: 'b', name: 'b', quantity: 1, unit: '' }];
    const p = plan(3, { now: PINNED_NOW }, items, toOffers({ s1: { a: 1, b: 1 }, s2: { a: 2, b: 2 }, s3: { a: 3 } }));
    expect(p.storeIds).toEqual(['s1']);
    expect(p.fulfillment).toBe('complete');
  });

  it('a store that supplies no line is not a stop (headings/extra stores never consume a stop)', () => {
    const p = plan(3);
    expect(p.storeIds).not.toContain('a1-cash-carry'); // A1 only helps at a 4-store cap
    const trip = computeTripPlan(BASKET, buildOffers(), 3, undefined, STORE_NAMES, fixtureContext());
    expect(trip.numStops).toBe(3);
    expect(trip.stops.every((s) => s.items.length > 0)).toBe(true);
  });

  it('tie-breaking is stable regardless of input order', () => {
    const items = [{ id: 'a', name: 'a', quantity: 1, unit: '' }];
    const forward = plan(1, { now: PINNED_NOW }, items, toOffers({ alpha: { a: 2 }, beta: { a: 2 } }));
    const reverse = plan(1, { now: PINNED_NOW }, items, toOffers({ beta: { a: 2 }, alpha: { a: 2 } }));
    expect(forward.storeIds).toEqual(['alpha']);
    expect(reverse.storeIds).toEqual(['alpha']);
  });

  it('larger quantities and stock limits never double count or break the stop cap', () => {
    const items = [
      { id: 'a', name: 'a', quantity: 3, unit: '' },
      { id: 'b', name: 'b', quantity: 1, unit: '' },
    ];
    const offers: StoreOffers = {
      cheap: { a: simple(1, { stockQuantity: 2 }), b: simple(1) },
      other: { a: simple(2), b: simple(3) },
    };
    const p1 = plan(1, { now: PINNED_NOW }, items, offers);
    // cheap can't sell 3 of a (no split): the only full single store is "other"
    expect(p1.storeIds).toEqual(['other']);
    expect(p1.totalCents).toBe(900);
    const p2 = plan(2, { now: PINNED_NOW }, items, offers);
    expect(p2.totalCents).toBe(700); // a 3×2 at other + b 1 at cheap — counted once each
    expect(p2.lines.filter((l) => l.status === 'costed')).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Time and evidence
// ════════════════════════════════════════════════════════════════════════════

describe('E. time and evidence', () => {
  it('on 8 Oct (local day after 7 Oct) the carrot and Cascade sales are ineligible; totals are recomputed', () => {
    const ctx = fixtureContext({ now: OCT_8_NOON });
    const analysis = analyzeBasket(BASKET, buildOffers(), ctx);
    const two = solvePlan(analysis, 2, ctx);
    const three = solvePlan(analysis, 3, ctx);
    expect(line(three, 'carrots').option?.storeId).toBe('no-frills');
    expect(line(three, 'cascade').status).toBe('held');
    expect(two.totalCents).toBe(6721); // not 7720
    expect(three.totalCents).toBe(6632); // not 7329
    expect(three.costedCount).toBe(9);
    expect(three.heldCount).toBe(2);
    expect(compareSavings(three, two)).toEqual({ status: 'available', amountCents: 89 });
  });

  it('date-only end: valid all of 7 Oct local, invalid from local midnight 8 Oct', () => {
    const carrots = (buildOffers().fortinos.carrots as PriceResult);
    const item = BASKET.find((i) => i.id === 'carrots')!;
    const lastMinute = startOfLocalDay('2026-10-08', TZ) - 60 * 1000;
    const midnight = startOfLocalDay('2026-10-08', TZ);
    expect(localDate(lastMinute, TZ)).toBe('2026-10-07');
    expect(assessOffer(carrots, item, { now: lastMinute, timeZone: TZ }).eligible).toBe(true);
    expect(assessOffer(carrots, item, { now: midnight, timeZone: TZ }).reasons).toContain('expired');
  });

  it('a weekly window past the sale end does not guarantee the price all week', () => {
    const ctx = fixtureContext({ shoppingDate: '2026-10-04', shoppingThrough: '2026-10-10' });
    const three = plan(3, ctx);
    expect(line(three, 'carrots').option?.storeId).toBe('no-frills');
    expect(line(three, 'cascade').status).toBe('held');
    expect(line(three, 'cascade').reasons).toContain('expires_before_shopping');
    expect(three.totalCents).toBe(6632);
  });

  it('a shopping date after expiry rejects the price even though the cache was filled before expiry', () => {
    const p = plan(3, fixtureContext({ shoppingDate: '2026-10-08' })); // clock still 4 Oct
    expect(p.totalCents).toBe(6632);
  });

  it('an exact-time end must last through the shopping day', () => {
    const endsWed2359 = Date.UTC(2026, 9, 8, 3, 59, 0); // 7 Oct 23:59 EDT
    const pr = offer('fortinos', 'Bread', 1.9, { validTo: endsWed2359 });
    expect(assessOffer(pr, { name: 'bread' }, { now: PINNED_NOW, shoppingDate: '2026-10-07', timeZone: TZ }).eligible).toBe(true);
    expect(assessOffer(pr, { name: 'bread' }, { now: PINNED_NOW, shoppingDate: '2026-10-08', timeZone: TZ }).reasons)
      .toEqual(['expires_before_shopping']);
    const endsNoon = Date.UTC(2026, 9, 7, 16); // 7 Oct 12:00 EDT — partial day
    expect(assessOffer(offer('fortinos', 'Bread', 1.9, { validTo: endsNoon }), { name: 'bread' },
      { now: PINNED_NOW, shoppingDate: '2026-10-07', timeZone: TZ }).eligible).toBe(false);
  });

  it('on 26 Oct the Costco gummies offer is ineligible unless refreshed', () => {
    const ctx = fixtureContext({ now: OCT_26_NOON });
    const p = plan(3, ctx);
    expect(line(p, 'gummies')).toMatchObject({ status: 'unavailable' });
    expect(line(p, 'gummies').reasons).toContain('expired');
    expect(p.fulfillment).toBe('incomplete');
    expect(p.claim).toBe('none');

    const refreshed = buildOffers();
    refreshed.costco.gummies = offer('costco', 'Kirkland Signature Fruit Gummies 90 ct', 16.29, {
      unit: 'box', requiresMembership: 'costco', timestamp: OCT_26_NOON - 3600 * 1000,
    });
    expect(line(plan(3, ctx, BASKET, refreshed), 'gummies').status).toBe('costed');
  });

  it('grapes have no sale expiry: freshness is judged by observation age, not an invented date', () => {
    const grapes = buildOffers()['no-frills'].grapes as PriceResult;
    const item = BASKET.find((i) => i.id === 'grapes')!;
    expect(grapes.validTo).toBeUndefined();
    expect(grapes.validThroughDate).toBeUndefined();
    expect(assessOffer(grapes, item, fixtureContext()).verified).toBe(true); // observed 2 Oct
    const oct10 = assessOffer(grapes, item, fixtureContext({ now: Date.UTC(2026, 9, 10, 16) }));
    expect(oct10).toMatchObject({ eligible: true, verified: false });
    expect(oct10.caveats).toContain('aging');
    expect(assessOffer(grapes, item, fixtureContext({ now: Date.UTC(2026, 10, 2, 16) })).reasons).toContain('stale');
  });

  it('missing branch/channel/stock, wrong city, stale, vanished and unconfirmed membership are never verified', () => {
    const item = { name: 'bread' };
    const ctx = fixtureContext({ city: 'Waterdown' });
    const ok = offer('fortinos', 'Bread', 2);
    expect(assessOffer(ok, item, ctx).verified).toBe(true);

    const noBranch = offer('fortinos', 'Bread', 2);
    delete noBranch.source.branchId;
    expect(assessOffer(noBranch, item, ctx)).toMatchObject({ eligible: true, verified: false });
    expect(assessOffer(offer('fortinos', 'Bread', 2, { channel: undefined }), item, ctx).caveats).toContain('channel_unknown');
    expect(assessOffer(offer('fortinos', 'Bread', 2, { stockStatus: 'unknown' }), item, ctx).caveats).toContain('stock_unknown');
    expect(assessOffer(offer('fortinos', 'Bread', 2, { stockStatus: 'out_of_stock' }), item, ctx).reasons).toContain('out_of_stock');
    const montreal = offer('fortinos', 'Bread', 2);
    montreal.source.city = 'Montreal';
    expect(assessOffer(montreal, item, ctx).reasons).toContain('wrong_city');
    const otherBranch = offer('fortinos', 'Bread', 2);
    otherBranch.source.branchId = 'fortinos-ancaster';
    expect(assessOffer(otherBranch, item, { ...ctx, branchIds: { fortinos: 'fortinos-waterdown' } }).reasons).toContain('wrong_branch');
    expect(assessOffer(offer('fortinos', 'Bread', 2, { channel: 'online' }), item, ctx).reasons).toContain('wrong_channel');
    expect(assessOffer(offer('fortinos', 'Bread', 2, { unavailable: 'withdrawn' }), item, ctx).reasons).toContain('withdrawn');
    expect(assessOffer(offer('costco', 'Bread', 2, { requiresMembership: 'costco' }), item, { ...ctx, memberships: [] }).reasons)
      .toContain('membership_unconfirmed');
    expect(assessOffer(offer('fortinos', 'Bread', 2, { source: { adapterId: 'crowdsourced', tier: 'crowd', storeId: 'fortinos', storeName: 'Fortinos', branchId: 'b' } }), item, ctx).caveats)
      .toContain('crowd_reported');
  });

  it('without confirmed membership the Costco line is blocked, so no complete plan exists', () => {
    const p = plan(3, fixtureContext({ memberships: [] }));
    expect(line(p, 'gummies').reasons).toContain('membership_unconfirmed');
    expect(p.claim).toBe('none');
  });

  it('a failed refresh labels last-known data and cannot produce a verified result', () => {
    const offers = buildOffers();
    (offers['no-frills'].eggs as PriceResult).refreshFailedAt = PINNED_NOW;
    const p = plan(3, fixtureContext(), BASKET, offers);
    expect(p.totalCents).toBe(7329); // still usable as last-known
    expect(line(p, 'eggs').option?.verified).toBe(false);
    expect(p.claim).toBe('estimate');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F. Refresh and races
// ════════════════════════════════════════════════════════════════════════════

describe('F. recomputation', () => {
  it('editing a price used by the plan or its baseline updates totals, assignment and savings', () => {
    const ctx = fixtureContext();
    const offers = buildOffers();
    (offers.fortinos.bread as PriceResult).price = 2.99; // now dearer than No Frills
    const analysis = analyzeBasket(BASKET, offers, ctx);
    const three = solvePlan(analysis, 3, ctx);
    expect(line(three, 'bread').option?.storeId).toBe('no-frills');
    expect(three.totalCents).toBe(7720 - 302);
    expect(compareSavings(three, solvePlan(analysis, 2, ctx))).toEqual({ status: 'available', amountCents: 302 });
  });

  it('quantity, variant, sale-only, policy, stop cap and date each change the result', () => {
    const base = analyzeBasket(BASKET, buildOffers(), fixtureContext());
    const variants: [string, BasketItem[], PlanContext][] = [
      ['quantity', BASKET.map((i) => (i.id === 'carrots' ? { ...i, quantity: 700 } : i)), fixtureContext()],
      ['variant', BASKET.map((i) => (i.id === 'grapes' ? { ...i, name: 'red seedless grapes' } : i)), fixtureContext()],
      ['sale-only', BASKET.map((i) => (i.id === 'ketchup' ? { ...i, notes: '' } : i)), fixtureContext()],
      ['membership', BASKET, fixtureContext({ memberships: [] })],
      ['date', BASKET, fixtureContext({ shoppingDate: '2026-10-09' })],
      ['channel', BASKET, fixtureContext({ channel: 'online' })],
    ];
    for (const [label, items, ctx] of variants) {
      const a = analyzeBasket(items, buildOffers(), ctx);
      expect([label, a.contextKey === base.contextKey]).toEqual([label, false]);
      expect([label, solvePlan(a, 3, ctx).totalCents === 7329 && solvePlan(a, 3, ctx).costedCount === 10])
        .toEqual([label, false]);
    }
    expect(solvePlan(base, 2).totalCents).not.toBe(solvePlan(base, 3).totalCents);
  });

  it('advancing the clock across expiry, without touching the list, withdraws expired support', () => {
    const offers = buildOffers();
    const before = plan(3, fixtureContext({ now: PINNED_NOW }), BASKET, offers);
    const after = plan(3, fixtureContext({ now: OCT_8_NOON }), BASKET, offers);
    expect(before.totalCents).toBe(7329);
    expect(after.totalCents).toBe(6632);
    expect(after.lines.some((l) => l.option?.offer.validThroughDate === '2026-10-07')).toBe(false);
  });
});

describe('F. price-store ordering and refresh failures', () => {
  type Deferred = { resolve: (m: Map<string, PriceResult>) => void; reject: (e: Error) => void };
  let pending: Deferred[];

  beforeEach(() => {
    usePriceStore.getState().clearPrices();
    usePriceStore.getState().clearPerStorePrices();
    pending = [];
    (priceRegistry.getAllPrices as jest.Mock).mockImplementation(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject } as Deferred)),
    );
  });

  const items = [{ id: 'milk', name: 'milk' }];
  const result = (p: number) => new Map([['milk', simple(p)]]);

  it('an older request resolving last cannot revert a newer price', async () => {
    const older = usePriceStore.getState().loadPricesForAllStores(items, ['s1']);
    const newer = usePriceStore.getState().loadPricesForAllStores(items, ['s1']);
    pending[1].resolve(result(3.49)); // newer first
    await newer;
    pending[0].resolve(result(5.99)); // stale answer arrives late
    await older;
    expect(usePriceStore.getState().perStorePrices.s1.milk.price).toBe(3.49);
  });

  it('an older batch cannot overwrite a newer single-item edit', async () => {
    const batch = usePriceStore.getState().loadPricesForAllStores(items, ['s1']);
    (priceRegistry.getPrice as jest.Mock).mockImplementation(async () => simple(2.5));
    await usePriceStore.getState().loadSinglePrice('milk', 'milk', 's1');
    pending[0].resolve(result(5.99));
    await batch;
    expect(usePriceStore.getState().perStorePrices.s1.milk.price).toBe(2.5);
  });

  it('a failed refresh keeps last-known prices flagged, never as freshly verified', async () => {
    const first = usePriceStore.getState().loadPricesForAllStores(items, ['s1']);
    pending[0].resolve(result(3.49));
    await first;
    const refresh = usePriceStore.getState().refreshAllPrices(items, ['s1']);
    await Promise.resolve();
    pending[1].reject(new Error('offline'));
    await refresh;
    const state = usePriceStore.getState();
    const milk = state.perStorePrices.s1.milk;
    expect(milk.price).toBe(3.49);
    expect(milk.refreshFailedAt).toBeDefined();
    expect(state.error).toContain('offline');
    expect(state.storeErrors.s1).toBe('offline');
    expect(assessOffer(milk, { name: 'milk' }, { now: Date.now() }).verified).toBe(false);
  });

  it('a vanished offer is marked withdrawn, not kept live', async () => {
    const first = usePriceStore.getState().loadPricesForAllStores(items, ['s1']);
    pending[0].resolve(result(3.49));
    await first;
    const second = usePriceStore.getState().loadPricesForAllStores(items, ['s1']);
    pending[1].resolve(new Map());
    await second;
    const milk = usePriceStore.getState().perStorePrices.s1.milk;
    expect(milk.unavailable).toBe('withdrawn');
    expect(assessOffer(milk, { name: 'milk' }, { now: Date.now() }).eligible).toBe(false);
  });
});
