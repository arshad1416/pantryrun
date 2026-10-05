/**
 * Basket Correctness — regression tests for the 4 Oct 2026 shopping-workflow
 * assessment (ported from PR #3 onto src/pricing/basket-planner.ts). Each
 * block reproduces one finding that let a comparison cover different
 * products, quantities or rules than the person asked for:
 *
 *  1. Checked items were still priced / planned
 *  2. A partial store (Fortinos 3/12 at $7.88) was labelled cheapest
 *  3. Expired, stale and demo prices stayed eligible
 *  4. A price change returned a stale plan
 *  5. Notes / variants (green grapes, lactose-free, sale only) ignored
 *  6. Measured quantities priced as N × package
 *  7. Waterdown 2- and 3-stop fixture
 *
 * Deliberate difference from PR #3: a quantity that cannot be reconciled
 * with how the offer is sold (2 kg against an "each" price, or a per-unit
 * price with no package size) is HELD with a reason instead of assuming one
 * package — the fix plan forbids guessing package contents.
 *
 * Run: npx jest __tests__/basket-correctness.test.ts
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { OfferEvidence, PriceResult, PriceSourceTier } from '../src/pricing/types';
import { planBasket, evaluateCandidate, type PlannerContext } from '../src/pricing/basket-planner';
import { deriveBasketLine, type LineSource } from '../src/pricing/list-intent';
import { describeEvidence, localDate } from '../src/pricing/offer-evidence';
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
const TODAY = localDate(NOW);
const ctx: PlannerContext = { window: { start: TODAY, end: TODAY }, now: NOW };

function price(
  value: number,
  evidence: Partial<OfferEvidence> = {},
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
    evidence: { provenance: tier === 'flyer' ? 'flyer' : 'manual', observedAt: NOW, ...evidence },
  };
}

function item(id: string, extra: Partial<LineSource> = {}): LineSource {
  return { id, name: id, quantity: 1, unit: '', ...extra };
}

function reasons(line: LineSource, pr: PriceResult, c: PlannerContext = ctx): string[] {
  return evaluateCandidate(deriveBasketLine(line), 's', 'S', pr, c).reasons;
}

function deal(name: string, merchant: string, priceReal: number, validTo: Date): FlippDealRow {
  return { merchant, name, price: String(priceReal), price_real: priceReal, image_url: null, valid_to: validTo.toISOString() };
}

// ─── 1. Checked items ───────────────────────────────────────────────────────

describe('1. checked items are out of the basket', () => {
  it('a checked item never reaches the plan or its total', () => {
    const plan = planBasket(
      [item('milk'), item('steak', { isChecked: true })],
      { s1: { milk: price(4), steak: price(30) } },
      {},
      3,
      ctx,
    );
    expect(plan.proposals[0]!.merchandiseTotal).toBe(4);
    expect(plan.proposals[0]!.coveredItemIds).toEqual(['milk']);
    expect(plan.lines.find((l) => l.line.itemId === 'steak')!.status).toBe('not_buying');
  });
});

// ─── 2. Partial stores are never "cheapest" ─────────────────────────────────

describe('2. coverage-first comparisons (Fortinos $7.88 for 3/12)', () => {
  const basket = Array.from({ length: 12 }, (_, i) => item(`i${i}`));
  const fullStore = Object.fromEntries(basket.map((it) => [it.id, price(3)])); // 36.00
  const fortinos = { i0: price(2.5), i1: price(2.69), i2: price(2.69) }; // 7.88 for 3 of 12

  it('the 1-stop route is the full-basket store, not the $7.88 partial one', () => {
    const plan = planBasket(basket, { fortinos, 'no-frills': fullStore }, { fortinos: 'Fortinos', 'no-frills': 'No Frills' }, 3, ctx);
    expect(plan.proposals[0]!.stores[0]!.storeName).toBe('No Frills');
    expect(plan.proposals[0]!.coveredItemIds).toHaveLength(12);
    expect(plan.proposals[0]!.merchandiseTotal).toBe(36);
    const f = plan.storeCoverage.find((s) => s.storeId === 'fortinos')!;
    expect([f.subtotal, f.coveredItemIds.length, f.complete]).toEqual([7.88, 3, false]);
  });

  it('a route covering different items reports no savings (null), not $0', () => {
    const a = Object.fromEntries(basket.slice(0, 6).map((it) => [it.id, price(1)]));
    const b = Object.fromEntries(basket.slice(6).map((it) => [it.id, price(1)]));
    const plan = planBasket(basket, { a, b }, {}, 2, ctx);
    expect(plan.proposals.map((p) => p.coveredItemIds.length)).toEqual([6, 12]);
    expect(plan.proposals[1]!.savingsVsOneStop).toBeNull();
    expect(plan.proposals[1]!.savingsVsPrevious).toBeNull();
  });

  it('a route lists the items it cannot supply', () => {
    const plan = planBasket([item('milk'), item('patties')], { s1: { milk: price(4) }, s2: { patties: price(5) } }, {}, 1, ctx);
    expect(plan.proposals[0]!.missingItemIds).toEqual(['patties']);
    expect(plan.hasCompleteRoute).toBe(false);
  });

  it('route proposals stop at maxStops', () => {
    const stores = Object.fromEntries(basket.slice(0, 5).map((it, i) => [`s${i}`, { [it.id]: price(1) }]));
    const plan = planBasket(basket, stores, {}, 3, ctx);
    expect(Math.max(...plan.proposals.map((p) => p.stores.length))).toBeLessThanOrEqual(3);
  });
});

// ─── 3. Expired / stale / demo evidence ─────────────────────────────────────

describe('3. expired, stale and demo prices are ineligible', () => {
  const milk = item('milk');

  it('an offer that ended yesterday is expired', () => {
    expect(reasons(milk, price(2, { validTo: localDate(NOW - DAY) }))[0]).toMatch(/^offer ended /);
  });

  it('an old observation is stale (manual prices: 14 days)', () => {
    expect(reasons(milk, price(2, { observedAt: NOW - 45 * DAY }))).toEqual(['price is 45 days old (stale)']);
  });

  it('seeded demo prices are excluded unless asked for (dev builds)', () => {
    expect(reasons(milk, price(2, { provenance: 'demo' }))).toEqual(['sample price — not a real store price']);
    expect(reasons(milk, price(2, { provenance: 'demo' }), { ...ctx, includeDemo: true })).toEqual([]);
  });

  it('a store left with nothing usable proposes nothing', () => {
    const plan = planBasket([milk], { old: { milk: price(1, { validTo: localDate(NOW - DAY) }) }, ok: { milk: price(3) } }, {}, 3, ctx);
    expect(plan.storeCoverage.map((s) => s.storeId)).toEqual(['ok']);
  });

  it('Flipp: expired cached deals are skipped; observation is fetch time, validTo is the offer end', async () => {
    flippDealsAdapter.clearCache();
    const ends = new Date(NOW + 3 * DAY);
    mockDeals = [
      deal('Milk 4 L', 'Fortinos', 3.0, new Date(NOW - DAY)), // ended
      deal('Milk 4 L', 'Fortinos', 5.49, ends),
    ];
    const result = await flippDealsAdapter.getPrice('milk', 'fortinos');
    expect(result?.price).toBeCloseTo(5.49);
    expect(result?.evidence?.validTo).toBe(localDate(ends.getTime()));
    expect(result?.evidence?.observedAt).toBeGreaterThanOrEqual(NOW);
    expect(result?.timestamp).toBeLessThanOrEqual(Date.now());
    expect(result?.evidence?.productName).toBe('Milk 4 L');
  });

  it('evidence labels say where a price came from', () => {
    expect(describeEvidence(price(1, { provenance: 'demo' }))).toBe('Sample');
    expect(describeEvidence(price(1, { provenance: 'unverified', observedAt: NOW - 3 * DAY }, 'crowd'), NOW)).toBe('Crowd · 3d ago');
    expect(describeEvidence(price(1, { validTo: localDate(NOW + DAY) }, 'flyer'))).toMatch(/^Flyer · ends /);
  });
});

// ─── 4. Price changes ───────────────────────────────────────────────────────

describe('4. a price change always changes the plan', () => {
  it('there is no plan cache to go stale: the plan is recomputed from current prices', () => {
    const items = [item('milk')];
    expect(planBasket(items, { s1: { milk: price(4) } }, {}, 3, ctx).proposals[0]!.merchandiseTotal).toBe(4);
    expect(planBasket(items, { s1: { milk: price(2) } }, {}, 3, ctx).proposals[0]!.merchandiseTotal).toBe(2);
  });

  it('a unit change changes the plan', () => {
    const prices = { s1: { milk: price(4, { packageSize: { amount: 1, unit: 'L' } }) } };
    expect(planBasket([item('milk', { quantity: 2, unit: 'L' })], prices, {}, 3, ctx).proposals[0]!.merchandiseTotal).toBe(8);
    expect(planBasket([item('milk', { quantity: 2, unit: 'mL' })], prices, {}, 3, ctx).proposals[0]!.merchandiseTotal).toBe(4);
  });
});

// ─── 5. Notes & variants ────────────────────────────────────────────────────

describe('5. notes and variants constrain matches', () => {
  it('green grapes do not match a red grape deal', () => {
    expect(reasons(item('green grapes'), price(2.99, { productName: 'Red Seedless Grapes' }, 'flyer'))).toEqual([
      'offer is RED; list requires GREEN',
    ]);
    expect(reasons(item('green grapes'), price(3.49, { productName: 'Green Seedless Grapes' }, 'flyer'))).toEqual([]);
  });

  it('lactose-free milk does not match plain milk', () => {
    expect(reasons(item('lactose-free milk'), price(5.49, { productName: 'Neilson 2% Milk 4 L' }))).toEqual([
      'no evidence the offer is LACTOSE-FREE',
    ]);
    expect(reasons(item('lactose-free milk'), price(6.49, { productName: 'Lactantia Lactose Free Milk 2 L' }))).toEqual([]);
  });

  it('a note requirement is enforced (milk, "lactose-free only")', () => {
    expect(reasons(item('milk', { notes: 'lactose-free only' }), price(5.49, { productName: '2% Milk' }))).toEqual([
      'no evidence the offer is LACTOSE-FREE',
    ]);
    expect(reasons(item('patties', { notes: 'must be Tastee' }), price(5.99, { productName: 'Tastee Beef Patties' }))).toEqual([]);
  });

  it('Jamaican patties must be Jamaican patties', () => {
    expect(reasons(item('Jamaican patties'), price(4.99, { productName: 'Beef Patties 8 pk' }))).toEqual([
      'no evidence the offer is JAMAICAN',
    ]);
    expect(reasons(item('Jamaican patties'), price(5.99, { productName: 'Tastee Jamaican Beef Patties' }))).toEqual([]);
  });

  it('"sale only" rejects a regular price and accepts a flyer offer', () => {
    const rule = item('jamaican patties', { notes: 'sale only' });
    expect(reasons(rule, price(4.99, { productName: 'Jamaican Patties' }))).toEqual(['sale-only: no verified sale price']);
    expect(reasons(rule, price(3.99, { productName: 'Jamaican Patties', isSale: true }, 'flyer'))).toEqual([]);
  });

  it('Flipp matching is whole-word: "milk" does not match buttermilk', async () => {
    flippDealsAdapter.clearCache();
    mockDeals = [deal('Buttermilk 1 L', 'Metro', 2.49, new Date(NOW + 5 * DAY))];
    expect(await flippDealsAdapter.getPrice('milk', 'metro')).toBeNull();
  });
});

// ─── 6. Quantities ──────────────────────────────────────────────────────────

describe('6. quantity math buys whole packages', () => {
  const jug = price(5.49, { packageSize: { amount: 4, unit: 'L' } });
  const lineTotal = (line: LineSource, pr: PriceResult) => evaluateCandidate(deriveBasketLine(line), 's', 'S', pr, ctx).lineTotal;

  it('2 L of milk from a 4 L jug is one jug, not 2 × the price', () => {
    expect(lineTotal(item('milk', { quantity: 2, unit: 'L' }), jug)).toBe(5.49);
    expect(lineTotal(item('milk', { quantity: 5, unit: 'L' }), jug)).toBe(10.98);
  });

  it('converts between units of the same dimension', () => {
    expect(lineTotal(item('milk', { quantity: 1000, unit: 'mL' }), price(3, { packageSize: { amount: 1, unit: 'L' } }))).toBe(3);
    expect(lineTotal(item('rice', { quantity: 500, unit: 'g' }), price(4.4, { priceBasis: 'per_kg' }))).toBe(2.2);
  });

  it('a count with no unit is a number of packages', () => {
    expect(lineTotal(item('buns', { quantity: 3 }), price(2))).toBe(6);
  });

  it('CHANGED from PR #3: a mismatched unit is held with a reason, not assumed to be one package', () => {
    expect(reasons(item('potatoes', { quantity: 2, unit: 'kg' }), price(3.99))).toEqual([
      'package size unknown; cannot tell how many packs make 2 kg',
    ]);
  });
});

// ─── 7. Waterdown fixture ───────────────────────────────────────────────────

describe('7. Waterdown weekly trip (No Frills / Fortinos / Food Basics)', () => {
  const names = { 'no-frills': 'No Frills', fortinos: 'Fortinos', 'food-basics': 'Food Basics' };
  const basket: LineSource[] = [
    { id: 'grapes', name: 'green grapes', quantity: 1, unit: '' },
    { id: 'milk', name: 'lactose-free milk', quantity: 2, unit: 'L' },
    { id: 'patties', name: 'Jamaican patties', quantity: 1, unit: '', notes: 'sale only' },
    { id: 'bread', name: 'bread', quantity: 1, unit: '' },
    { id: 'eggs', name: 'eggs', quantity: 1, unit: '' },
  ];
  const twoL = { amount: 2, unit: 'L' };
  const raw: Record<string, Record<string, PriceResult>> = {
    'no-frills': {
      grapes: price(3.99, { productName: 'Green Seedless Grapes' }),
      milk: price(6.29, { productName: 'Lactose Free Milk', packageSize: twoL }),
      patties: price(5.99, { productName: 'Jamaican Beef Patties' }), // not on sale
      bread: price(2.49),
      eggs: price(3.79),
    },
    fortinos: {
      grapes: price(2.99, { productName: 'Red Seedless Grapes' }), // wrong variant
      patties: price(4.49, { productName: 'Jamaican Patties' }, 'flyer'),
      bread: price(2.29, { validTo: localDate(NOW - DAY) }), // expired
    },
    'food-basics': {
      grapes: price(3.49, { productName: 'Green Grapes' }),
      milk: price(5.99, { productName: 'Lactose Free Milk', packageSize: twoL }),
      bread: price(2.19),
      eggs: price(4.29),
    },
  };
  const plan = (k: number) => planBasket(basket, raw, names, k, ctx);

  it('eligibility removes the wrong grapes, the regular-price patties and the expired bread', () => {
    const p = plan(3);
    const fortinos = p.storeCoverage.find((s) => s.storeId === 'fortinos')!;
    expect(fortinos.coveredItemIds).toEqual(['patties']);
    const patties = p.lines.find((l) => l.line.itemId === 'patties')!;
    expect(patties.candidates.find((c) => c.storeId === 'no-frills')!.verdict).toBe('excluded');
  });

  it('2 stops: Food Basics + Fortinos covers everything for $20.45', () => {
    const two = plan(2).proposals[1]!;
    expect(two.complete).toBe(true);
    expect(two.stores.map((s) => s.storeName).sort()).toEqual(['Food Basics', 'Fortinos']);
    expect(two.merchandiseTotal).toBe(20.45);
    // No single store carries the sale patties → no honest 1-stop comparison
    expect(two.savingsVsOneStop).toBeNull();
  });

  it('3 stops: adding No Frills saves $0.50 on eggs', () => {
    const three = plan(3).proposals[2]!;
    expect(three.stores).toHaveLength(3);
    expect(three.merchandiseTotal).toBe(19.95);
    expect(three.savingsVsPrevious).toBe(0.5);
    expect(three.stores.find((s) => s.storeId === 'no-frills')!.itemIds).toEqual(['eggs']);
  });

  it('route cards show coverage', () => {
    const p = plan(3);
    expect(p.proposals[0]!.coveredItemIds).toHaveLength(4); // best single store misses the patties
    expect(p.proposals[0]!.stores[0]!.storeName).toBe('Food Basics');
    expect(p.proposals.map((x) => x.merchandiseTotal)).toEqual([15.96, 20.45, 19.95]);
  });
});
