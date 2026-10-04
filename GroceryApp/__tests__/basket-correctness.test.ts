/**
 * Basket Correctness — regression tests for the 4 Oct 2026 shopping-workflow
 * assessment. Each block reproduces one finding that let a comparison cover
 * different products, quantities or rules than the person asked for:
 *
 *  1. Checked items were still priced / planned
 *  2. A partial store (Fortinos 3/12 at $7.88) was labelled cheapest
 *  3. Expired flyer offers stayed eligible
 *  4. A price change returned a stale cached plan
 *  5. Notes / variants (green grapes, lactose-free, sale only) ignored
 *  6. Measured quantities priced as N × package
 *  7. Waterdown 2- and 3-stop fixture
 *
 * Run: npx jest __tests__/basket-correctness.test.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { PriceResult, PriceSourceTier } from '../src/pricing/types';
import {
  selectBasketItems,
  filterEligiblePrices,
  ineligibleReason,
  classifyMatch,
  evidenceStatus,
  lineCost,
  describeEvidence,
  type BasketItem,
} from '../src/pricing/basket';
import { computeStopProposals } from '../src/pricing/stop-optimizer';
import { computeTripPlan } from '../src/pricing/trip-plan';
import {
  buildCacheKey,
  getCachedPlan,
  setCachedPlan,
  invalidateCache,
} from '../src/pricing/trip-plan-cache';
import type { FlippDealRow } from '../src/services/dealMatcher';

// ─── Mocks (Flipp adapter dependencies) ─────────────────────────────────────

let mockDeals: FlippDealRow[] = [];
jest.mock('../src/services/dealMatcher', () => ({
  fetchDealsForFSA: async () => mockDeals,
}));
jest.mock('../src/config/settings', () => ({
  getSettings: () => ({ flyerScanEnabled: true, flippFsa: 'L0R' }),
}));

// eslint-disable-next-line import/first
import { flippDealsAdapter } from '../src/pricing/flipp-deals-adapter';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function price(
  value: number,
  overrides: Partial<PriceResult> = {},
  tier: PriceSourceTier = 'official',
): PriceResult {
  return {
    price: value,
    unitPrice: value,
    unit: 'ea',
    saleInfo: null,
    source: { adapterId: 'test', tier, storeId: 'test', storeName: 'Test' },
    timestamp: NOW,
    confidence: 'real_time',
    ...overrides,
  };
}

/** Basket item with the `unit` computeTripPlan requires */
type TestItem = BasketItem & { unit: string };

function item(id: string, extra: Partial<TestItem> = {}): TestItem {
  return { id, name: id, quantity: 1, unit: '', ...extra };
}

function listItem(id: string, isChecked: boolean, listId = 'list-1') {
  return { id, name: id, quantity: 1, unit: '', listId, isDeleted: false, isChecked };
}

function deal(name: string, merchant: string, priceReal: number, validTo: Date): FlippDealRow {
  return {
    merchant,
    name,
    price: String(priceReal),
    price_real: priceReal,
    image_url: null,
    valid_to: validTo.toISOString(),
  };
}

// ─── 1. Checked items ───────────────────────────────────────────────────────

describe('1. checked items are out of the basket', () => {
  it('selectBasketItems drops checked, deleted and other-list items', () => {
    const items = {
      a: listItem('a', false),
      b: listItem('b', true),
      c: { ...listItem('c', false), isDeleted: true },
      d: listItem('d', false, 'list-2'),
    };
    expect(selectBasketItems(items, 'list-1').map((i) => i.id)).toEqual(['a']);
  });

  it('a checked item never reaches the plan or its total', () => {
    const items = [listItem('milk', false), listItem('steak', true)];
    const basket = selectBasketItems(items, 'list-1');
    const plan = computeTripPlan(basket, {
      s1: { milk: price(4), steak: price(30) },
    });
    expect(plan.totalCost).toBeCloseTo(4);
    expect(plan.stops[0].items.map((i) => i.itemId)).toEqual(['milk']);
  });
});

// ─── 2. Partial stores are never "cheapest" ─────────────────────────────────

describe('2. coverage-first comparisons (Fortinos $7.88 for 3/12)', () => {
  const basket = Array.from({ length: 12 }, (_, i) => item(`i${i}`));
  const fullStore = Object.fromEntries(basket.map((it) => [it.id, price(3)])); // 36.00
  const fortinos = {
    i0: price(2.5),
    i1: price(2.69),
    i2: price(2.69),
  }; // 7.88 for 3 of 12

  it('the 1-stop route is the full-basket store, not the $7.88 partial one', () => {
    const proposals = computeStopProposals(
      basket,
      { fortinos, 'no-frills': fullStore },
      { fortinos: 'Fortinos', 'no-frills': 'No Frills' },
    );
    expect(proposals[0].stores[0].storeName).toBe('No Frills');
    expect(proposals[0].coveredCount).toBe(12);
    expect(proposals[0].totalCount).toBe(12);
    expect(proposals[0].totalCost).toBeCloseTo(36);
  });

  it('a route covering different items reports no savings (null), not $0', () => {
    // Neither store carries everything: A has i0..i5, B has i6..i11.
    const a = Object.fromEntries(basket.slice(0, 6).map((it) => [it.id, price(1)]));
    const b = Object.fromEntries(basket.slice(6).map((it) => [it.id, price(1)]));
    const proposals = computeStopProposals(basket, { a, b }, {});
    expect(proposals).toHaveLength(2);
    expect(proposals[0].coveredCount).toBe(6);
    expect(proposals[1].coveredCount).toBe(12);
    expect(proposals[1].savingsVsOneStop).toBeNull();

    const plan = computeTripPlan(basket, { a, b }, 2);
    expect(plan.savingsComparable).toBe(false);
    expect(plan.savings).toBe(0);
  });

  it('a route lists the items it cannot supply', () => {
    const proposals = computeStopProposals(
      [item('milk'), item('patties')],
      { s1: { milk: price(4) }, s2: { milk: price(5) } },
      {},
    );
    expect(proposals[0].missingItemIds).toEqual(['patties']);
  });

  it('route proposals stop at maxStops', () => {
    const stores = Object.fromEntries(
      basket.slice(0, 5).map((it, i) => [`s${i}`, { [it.id]: price(1) }]),
    );
    expect(computeStopProposals(basket, stores, {}, 3).length).toBeLessThanOrEqual(3);
  });
});

// ─── 3. Expired / stale / demo evidence ─────────────────────────────────────

describe('3. expired, stale and demo prices are ineligible', () => {
  const milk = item('milk');

  it('an offer that ended yesterday is expired', () => {
    expect(ineligibleReason(price(2, { validTo: NOW - DAY }), milk)).toBe('expired');
  });

  it('a 45-day-old observation is stale', () => {
    expect(ineligibleReason(price(2, { timestamp: NOW - 45 * DAY }), milk)).toBe('stale');
  });

  it('seeded demo prices are excluded unless asked for', () => {
    expect(ineligibleReason(price(2, { isDemo: true }), milk)).toBe('demo');
    expect(ineligibleReason(price(2, { isDemo: true }), milk, { includeDemo: true })).toBeNull();
  });

  it('filterEligiblePrices drops stores left with nothing usable', () => {
    const out = filterEligiblePrices([milk], {
      old: { milk: price(1, { validTo: NOW - DAY }) },
      ok: { milk: price(3) },
    });
    expect(Object.keys(out)).toEqual(['ok']);
  });

  it('Flipp: expired cached deals are skipped; timestamp is fetch time, validTo is the offer end', async () => {
    flippDealsAdapter.clearCache();
    const ends = new Date(NOW + 3 * DAY);
    mockDeals = [
      deal('Milk 4 L', 'Fortinos', 3.0, new Date(NOW - DAY)), // ended
      deal('Milk 4 L', 'Fortinos', 5.49, ends),
    ];
    const result = await flippDealsAdapter.getPrice('milk', 'fortinos');
    expect(result?.price).toBeCloseTo(5.49);
    expect(result?.validTo).toBe(ends.getTime());
    expect(result?.timestamp).toBeLessThanOrEqual(Date.now());
    expect(result?.timestamp).toBeGreaterThanOrEqual(NOW);
    expect(result?.matchedName).toBe('Milk 4 L');
  });

  it('evidence labels say where a price came from', () => {
    expect(describeEvidence(price(1, { isDemo: true }))).toBe('Demo');
    expect(describeEvidence(price(1, { timestamp: NOW - 3 * DAY }, 'crowd'), NOW)).toBe('Crowd · 3d ago');
    expect(describeEvidence(price(1, { validTo: NOW + DAY }, 'flyer'))).toMatch(/^Flyer · ends /);
  });
});

// ─── 4. Cache ───────────────────────────────────────────────────────────────

describe('4. a price change never returns a cached plan', () => {
  beforeEach(() => invalidateCache());

  it('changing a price changes the cache key', () => {
    const items = [item('milk')];
    const before = { s1: { milk: price(4) } };
    const after = { s1: { milk: price(2) } };
    setCachedPlan(buildCacheKey(3, items, before), computeTripPlan(items, before));
    expect(getCachedPlan(buildCacheKey(3, items, after))).toBeNull();
    expect(getCachedPlan(buildCacheKey(3, items, before))?.totalCost).toBeCloseTo(4);
  });

  it('changing a unit changes the cache key', () => {
    const prices = { s1: { milk: price(4) } };
    expect(buildCacheKey(3, [item('milk', { unit: 'L' })], prices))
      .not.toEqual(buildCacheKey(3, [item('milk', { unit: '' })], prices));
  });
});

// ─── 5. Notes & variants ────────────────────────────────────────────────────

describe('5. notes and variants constrain matches', () => {
  it('green grapes do not match a red grape deal', () => {
    const pr = price(2.99, { matchedName: 'Red Seedless Grapes' }, 'flyer');
    expect(ineligibleReason(pr, { name: 'green grapes' })).toBe('variant_mismatch');
    expect(
      ineligibleReason(price(3.49, { matchedName: 'Green Seedless Grapes' }, 'flyer'), { name: 'green grapes' }),
    ).toBeNull();
  });

  it('lactose-free milk does not match plain milk', () => {
    // "2% Milk" doesn't say it's lactose-free: unresolved, and never eligible.
    const plain = price(5.49, { matchedName: 'Neilson 2% Milk 4 L' });
    expect(ineligibleReason(plain, { name: 'lactose-free milk' })).toBe('unresolved_match');
    const lf = price(6.49, { matchedName: 'Lactantia Lactose Free Milk 2 L' });
    expect(ineligibleReason(lf, { name: 'lactose-free milk' })).toBeNull();
  });

  it('a note requirement is enforced (milk, "lactose-free only")', () => {
    const plain = price(5.49, { matchedName: '2% Milk' });
    expect(ineligibleReason(plain, { name: 'milk', notes: 'lactose-free only' })).toBe('unresolved_match');
  });

  it('Jamaican patties must be Jamaican patties', () => {
    const pr = price(4.99, { matchedName: 'Beef Patties 8 pk' });
    expect(ineligibleReason(pr, { name: 'Jamaican patties' })).toBe('unresolved_match');
    expect(
      ineligibleReason(price(5.99, { matchedName: 'Tastee Jamaican Beef Patties' }), { name: 'Jamaican patties' }),
    ).toBeNull();
  });

  it('"sale only" rejects a regular price and accepts a flyer offer', () => {
    const regular = price(4.99, { matchedName: 'Jamaican Patties' });
    const flyer = price(3.99, { matchedName: 'Jamaican Patties' }, 'flyer');
    const rule = { name: 'jamaican patties', notes: 'sale only' };
    expect(ineligibleReason(regular, rule)).toBe('not_on_sale');
    expect(ineligibleReason(flyer, rule)).toBeNull();
  });

  it('Flipp matching is whole-word: "milk" does not match buttermilk', async () => {
    flippDealsAdapter.clearCache();
    mockDeals = [deal('Buttermilk 1 L', 'Metro', 2.49, new Date(NOW + 5 * DAY))];
    expect(await flippDealsAdapter.getPrice('milk', 'metro')).toBeNull();
  });
});

describe('5b. evidence conditions and substitution policy', () => {
  it('an out-of-stock offer is unavailable; unknown stock is not "in stock" but stays usable', () => {
    expect(ineligibleReason(price(2, { stock: 'out_of_stock' }), { name: 'x' })).toBe('unavailable');
    expect(ineligibleReason(price(2), { name: 'x' })).toBeNull();
    expect(evidenceStatus(price(2, { stock: 'out_of_stock' }))).toBe('unavailable');
  });

  it('a member price needs that membership', () => {
    const member = price(2, { membership: 'PC Optimum' });
    expect(ineligibleReason(member, { name: 'x' })).toBe('membership_required');
    expect(ineligibleReason(member, { name: 'x' }, { memberships: ['PC Optimum'] })).toBeNull();
    expect(describeEvidence(member, NOW)).toMatch(/PC Optimum price$/);
  });

  it('evidence status separates retailer, manual, demo and expired prices', () => {
    expect(evidenceStatus(price(1, {}, 'flyer'))).toBe('verified');
    expect(evidenceStatus(price(1, {}, 'crowd'))).toBe('manual');
    expect(evidenceStatus(price(1, { isDemo: true }))).toBe('demo');
    expect(evidenceStatus(price(1, { validTo: NOW - DAY }), NOW)).toBe('expired');
  });

  it('a cheaper stand-in is only used when the note allows substitutes, never dropping a hard variant', () => {
    const pr = price(2, { matchedName: 'Lactose Free Milk' });
    // Default policy is exact: a missing ordinary word leaves the match unresolved.
    expect(classifyMatch(pr, { name: 'Neilson LF milk' })).toBe('unresolved');
    // "WHOLE" in capitals is hard, so even "any brand" can't drop it.
    expect(classifyMatch(pr, { name: 'WHOLE LF milk', notes: 'any brand' })).toBe('rejected');
    const loose = { name: 'Neilson LF milk', notes: 'any brand' };
    expect(classifyMatch(pr, loose)).toBe('substitute');
    expect(classifyMatch(price(2, { matchedName: 'Neilson 2% Milk' }), loose)).toBe('rejected');
  });
});

// ─── 6. Quantities ──────────────────────────────────────────────────────────

describe('6. quantity math buys whole packages', () => {
  it('2 L of milk from a 4 L jug is one jug, not 2 × the price', () => {
    const jug = price(5.49, { unit: 'L', packageSize: 4 });
    expect(lineCost({ quantity: 2, unit: 'L' }, jug)).toMatchObject({
      cost: 5.49, quantityAssumed: false, packages: 1, purchased: { amount: 4, unit: 'L' },
    });
    expect(lineCost({ quantity: 5, unit: 'L' }, jug).cost).toBeCloseTo(10.98);
  });

  it('converts between units of the same dimension', () => {
    const carton = price(3.0, { unit: 'L', packageSize: 1 });
    expect(lineCost({ quantity: 1000, unit: 'mL' }, carton).cost).toBeCloseTo(3.0);
    const perKg = price(4.4, { unit: 'kg' });
    expect(lineCost({ quantity: 500, unit: 'g' }, perKg).cost).toBeCloseTo(2.2);
  });

  it('a count with no unit is a number of packages', () => {
    expect(lineCost({ quantity: 3, unit: '' }, price(2)).cost).toBeCloseTo(6);
  });

  it('a mismatched unit assumes one package and says so', () => {
    expect(lineCost({ quantity: 2, unit: 'kg' }, price(3.99))).toMatchObject({
      cost: 3.99, quantityAssumed: true, packages: 1,
    });
  });

  it('the trip plan uses package math for its totals', () => {
    const plan = computeTripPlan(
      [{ id: 'milk', name: 'milk', quantity: 2, unit: 'L' }],
      { s1: { milk: price(5.49, { unit: 'L', packageSize: 4 }) } },
    );
    expect(plan.totalCost).toBeCloseTo(5.49);
    expect(plan.stops[0].items[0].lineTotal).toBeCloseTo(5.49);
  });
});

// ─── 7. Waterdown fixture ───────────────────────────────────────────────────

describe('7. Waterdown weekly trip (No Frills / Fortinos / Food Basics)', () => {
  const names = { 'no-frills': 'No Frills', fortinos: 'Fortinos', 'food-basics': 'Food Basics' };
  const basket: TestItem[] = [
    { id: 'grapes', name: 'green grapes', quantity: 1, unit: '' },
    { id: 'milk', name: 'lactose-free milk', quantity: 2, unit: 'L' },
    { id: 'patties', name: 'Jamaican patties', quantity: 1, unit: '', notes: 'sale only' },
    { id: 'bread', name: 'bread', quantity: 1, unit: '' },
    { id: 'eggs', name: 'eggs', quantity: 1, unit: '' },
  ];
  const raw: Record<string, Record<string, PriceResult>> = {
    'no-frills': {
      grapes: price(3.99, { matchedName: 'Green Seedless Grapes' }),
      milk: price(6.29, { matchedName: 'Lactose Free Milk', unit: 'L', packageSize: 2 }),
      patties: price(5.99, { matchedName: 'Jamaican Beef Patties' }), // not on sale
      bread: price(2.49),
      eggs: price(3.79),
    },
    fortinos: {
      grapes: price(2.99, { matchedName: 'Red Seedless Grapes' }), // wrong variant
      patties: price(4.49, { matchedName: 'Jamaican Patties' }, 'flyer'),
      bread: price(2.29, { validTo: NOW - DAY }), // expired
    },
    'food-basics': {
      grapes: price(3.49, { matchedName: 'Green Grapes' }),
      milk: price(5.99, { matchedName: 'Lactose Free Milk', unit: 'L', packageSize: 2 }),
      bread: price(2.19),
      eggs: price(4.29),
    },
  };
  const eligible = filterEligiblePrices(basket, raw);

  it('eligibility removes the wrong grapes, the regular-price patties and the expired bread', () => {
    expect(eligible.fortinos).toEqual({ patties: raw.fortinos.patties });
    expect(eligible['no-frills'].patties).toBeUndefined();
  });

  it('2 stops: Food Basics + Fortinos covers everything for $20.45', () => {
    const plan = computeTripPlan(basket, eligible, 2, undefined, names);
    // grapes 3.49 FB, milk 5.99 FB, bread 2.19 FB, eggs 4.29 FB, patties 4.49 Fortinos
    expect(plan.unassigned).toEqual([]);
    expect(plan.stops.map((s) => s.storeName).sort()).toEqual(['Food Basics', 'Fortinos']);
    expect(plan.totalCost).toBeCloseTo(20.45);
    // No single store carries the sale patties → no honest 1-stop comparison
    expect(plan.savingsComparable).toBe(false);
  });

  it('3 stops: adding No Frills saves $0.50 on eggs', () => {
    const plan = computeTripPlan(basket, eligible, 3, undefined, names);
    expect(plan.numStops).toBe(3);
    expect(plan.totalCost).toBeCloseTo(19.95);
    const nf = plan.stops.find((s) => s.storeId === 'no-frills');
    expect(nf?.items.map((i) => i.itemId)).toEqual(['eggs']);
  });

  it('route cards agree with Plan My Trip and show coverage', () => {
    const proposals = computeStopProposals(basket, eligible, names, 3);
    expect(proposals[0].coveredCount).toBe(4); // best single store misses the patties
    expect(proposals[0].stores[0].storeName).toBe('Food Basics');
    expect(proposals[1].coveredCount).toBe(5);
    expect(proposals[1].totalCost).toBeCloseTo(20.45);
    expect(proposals[1].savingsVsOneStop).toBeNull();
    expect(proposals[2].totalCost).toBeCloseTo(19.95);
  });
});
