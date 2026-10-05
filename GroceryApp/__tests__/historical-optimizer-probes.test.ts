/**
 * HISTORICAL PROBES — inputs that exposed defects in the retired optimizers
 * (src/pricing/stop-optimizer.ts, src/pricing/trip-plan.ts, removed in favour
 * of src/pricing/basket-planner.ts). Each probe re-runs the original input
 * and asserts the CORRECTED behaviour. The old result is recorded in the
 * comment so the defect stays identifiable; it is not an acceptance target.
 *
 * Probes that exercised the old store's refresh/edit paths live in
 * price-store-freshness.test.ts, and the crowd-adapter median probe in
 * ac8-prices.test.ts.
 */

import { describe, it, expect } from '@jest/globals';
import { planBasket } from '../src/pricing/basket-planner';
import type { PriceResult } from '../src/pricing/types';
import type { LineSource } from '../src/pricing/list-intent';

const NOW = Date.parse('2026-10-04T16:00:00Z');
const ctx = { window: { start: '2026-10-04', end: '2026-10-04' }, now: NOW };

/** A legacy-shaped result: no evidence, so it is treated as 'unverified'. */
function legacy(price: number, storeId = 'x'): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: { adapterId: 'test', tier: 'official', storeId, storeName: storeId },
    timestamp: NOW,
    confidence: 'real_time',
  };
}

const each = (id: string, quantity = 1): LineSource => ({ id, name: id, quantity, unit: 'ea' });

describe('stop-optimizer.ts probes', () => {
  it('PROBE "price only in some stores": a 1-item store no longer beats a complete one', () => {
    // Old: 1-stop = store_a at $4.99 (milk only); no 2-stop proposal at all.
    const p = planBasket(
      [each('milk'), each('specialty_item')],
      { store_a: { milk: legacy(4.99) }, store_b: { milk: legacy(5.49), specialty_item: legacy(12.99) } },
      {},
      3,
      ctx,
    );
    expect(p.proposals[0]!.stores.map((s) => s.storeId)).toEqual(['store_b']);
    expect(p.proposals[0]!.merchandiseTotal).toBe(18.48);
    expect(p.proposals[0]!.complete).toBe(true);
    expect(p.proposals[1]!.merchandiseTotal).toBe(17.98);
    expect(p.proposals[1]!.savingsVsPrevious).toBe(0.5);
  });

  it('PROBE "no price in any store": the unpriced line is held, not silently $0', () => {
    // Old: unknown_item contributed $0 and was not mentioned.
    const p = planBasket(
      [each('milk'), each('unknown_item')],
      { store_a: { milk: legacy(4.99) }, store_b: { milk: legacy(3.99) } },
      {},
      3,
      ctx,
    );
    expect(p.held).toEqual([{ itemId: 'unknown_item', name: 'unknown_item', reasons: ['no price found at any store'] }]);
    expect(p.eligibleItemIds).toEqual(['milk']);
  });

  it('PROBE "Best Value": no route is labelled best by stop count alone', () => {
    // Old UI: `isBestValue = prop.numStops === 2` regardless of the numbers.
    const p = planBasket([each('milk')], { a: { milk: legacy(2) }, b: { milk: legacy(2) } }, {}, 3, ctx);
    expect(p.proposals).toHaveLength(1); // a second stop that saves nothing is not offered
  });

  it('PROBE "quantity scaling": quantity multiplies per pack, and arithmetic is exact to the cent', () => {
    // Old: 3 × $3.50 = 10.50 (kept — this one was right).
    const p = planBasket([each('milk', 3)], { a: { milk: legacy(4) }, b: { milk: legacy(3.5) } }, {}, 3, ctx);
    expect(p.proposals[0]!.merchandiseTotal).toBe(10.5);
  });
});

describe('trip-plan.ts probes', () => {
  it('PROBE "unassigned items price: 0": held lines carry reasons instead of a zero price', () => {
    // Old: unpriced items appeared in `unassigned` with price 0 and the
    // savings figure silently ignored them.
    const p = planBasket(
      [each('milk'), { id: 'flour', name: 'flour', quantity: 2, unit: 'kg' }],
      { a: { milk: legacy(4, 'a'), flour: legacy(3, 'a') } },
      {},
      3,
      ctx,
    );
    // Flour is asked for by mass; the legacy offer has no package size.
    expect(p.held[0]!.reasons[0]).toBe('a: package size unknown; cannot tell how many packs make 2 kg');
  });

  it('PROBE "greedy above 7 stores": every store set within the limit is now searched exactly', () => {
    // Old: >7 stores fell back to a greedy search that could miss the optimum.
    const stores: Record<string, Record<string, PriceResult>> = {};
    for (let i = 0; i < 9; i++) stores[`s${i}`] = { a: legacy(10), b: legacy(10), c: legacy(10) };
    stores.s7!.a = legacy(1);
    stores.s7!.b = legacy(1);
    stores.s8!.c = legacy(1);
    const p = planBasket([each('a'), each('b'), each('c')], stores, {}, 2, ctx);
    expect(p.proposals[p.proposals.length - 1]!.merchandiseTotal).toBe(3);
  });

  it('PROBE "maxStops up to 5": the stop limit is clamped to 3', () => {
    const stores: Record<string, Record<string, PriceResult>> = {};
    for (let i = 0; i < 5; i++) stores[`s${i}`] = { [`i${i}`]: legacy(1) };
    const items = [0, 1, 2, 3, 4].map((i) => each(`i${i}`));
    const p = planBasket(items, stores, {}, 5, ctx);
    expect(Math.max(...p.proposals.map((x) => x.stores.length))).toBe(3);
    expect(p.hasCompleteRoute).toBe(false);
  });
});

describe('screen-level probes', () => {
  it('PROBE "quick-add Apples 6 pcs × 6-pack price": a pack price is no longer multiplied by the count', () => {
    // Old: the seeded $1.99 price was for a 6-apple pack, and the list line
    // "6 pcs" multiplied it by 6 → $11.94.
    const pack: PriceResult = {
      ...legacy(1.99),
      evidence: { provenance: 'demo', packageSize: { amount: 6, unit: 'pcs' }, observedAt: NOW },
    };
    const p = planBasket([{ id: 'apples', name: 'Apples', quantity: 6, unit: 'pcs' }], { nf: { apples: pack }, x: {} }, {}, 3, { ...ctx, includeDemo: true });
    expect(p.proposals[0]!.merchandiseTotal).toBe(1.99);
    expect(p.proposals[0]!.assignments[0]!.candidate.packs).toBe(1);
  });

  it('PROBE "Fortinos $7.88 shown as the cheapest store": partial coverage is disclosed and ranked last', () => {
    const p = planBasket(
      [each('a'), each('b'), each('c')],
      { fortinos: { a: legacy(1), b: legacy(1) }, full: { a: legacy(3), b: legacy(3), c: legacy(3) } },
      {},
      1,
      ctx,
    );
    expect(p.storeCoverage.map((s) => [s.storeId, s.coveredItemIds.length, s.complete])).toEqual([
      ['full', 3, true],
      ['fortinos', 2, false],
    ]);
  });
});
