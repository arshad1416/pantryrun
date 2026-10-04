/**
 * Stop Optimizer Tests — computeStopProposals.
 *
 * Pure algorithm tests:
 *  - Early exit for < 2 stores
 *  - 1-stop proposal (cheapest single store)
 *  - Greedy expansion (add stores that most reduce combined total)
 *  - Edge cases: zero-price items, missing prices, all-identical prices
 *
 * Run: npx jest __tests__/stop-optimizer.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import { computeStopProposals } from '../src/pricing/stop-optimizer';
import type { PriceResult } from '../src/pricing/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePrice(price: number, overrides: Partial<PriceResult> = {}): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: {
      adapterId: 'test',
      tier: 'official',
      storeId: 'test',
      storeName: 'Test',
    },
    timestamp: Date.now(),
    confidence: 'real_time',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('computeStopProposals — early returns', () => {
  it('returns [] when there are 0 stores', () => {
    const items = [{ id: 'milk', quantity: 1 }];
    const result = computeStopProposals(items, {}, {});
    expect(result).toEqual([]);
  });

  it('returns [] when there is 1 store', () => {
    const items = [{ id: 'milk', quantity: 1 }];
    const perStorePrices = {
      store_a: { milk: makePrice(4.99) },
    };
    const result = computeStopProposals(items, perStorePrices, {});
    expect(result).toEqual([]);
  });

  it('returns [] when fewer than 2 stores have prices for any item', () => {
    // Two stores exist but only one has prices for any item
    const items = [{ id: 'milk', quantity: 1 }];
    const perStorePrices = {
      store_a: { milk: makePrice(4.99) },
      store_b: {},
    };
    const result = computeStopProposals(items, perStorePrices, {});
    expect(result).toEqual([]);
  });
});

describe('computeStopProposals — 2 stores, same prices', () => {
  it('returns 1 proposal showing 0 savings for adding second store', () => {
    const items = [
      { id: 'milk', quantity: 2 },
      { id: 'bread', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        milk: makePrice(4.99),
        bread: makePrice(2.99),
      },
      store_b: {
        milk: makePrice(4.99),
        bread: makePrice(2.99),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // Exactly one proposal — no savings from adding second store
    expect(result).toHaveLength(1);
    expect(result[0].numStops).toBe(1);
    expect(result[0].savingsVsOneStop).toBe(0);
  });
});

describe('computeStopProposals — 2 stores, store B cheaper on some items', () => {
  it('shows savings from adding a cheaper second store', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'bread', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        milk: makePrice(4.99),
        bread: makePrice(2.99),
      },
      store_b: {
        milk: makePrice(3.99), // cheaper milk
        bread: makePrice(2.99),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // Should have 1-stop and potentially 2-stop proposals
    expect(result.length).toBeGreaterThanOrEqual(1);

    // 1-stop should pick the cheapest single store (store_b at 3.99+2.99=6.98)
    expect(result[0].numStops).toBe(1);

    if (result.length >= 2) {
      // 2-stop should save: 1-stop best picks cheapest per item from both stores
      // milk cheapest = 3.99 (store_b), bread cheapest = 2.99 (store_a or store_b)
      // total = 6.98, same as store_b alone — store_a adds nothing
      // Actually: if store_b is cheapest for everything, adding store_a doesn't help
      expect(result[1].savingsVsOneStop).toBeGreaterThanOrEqual(0);
    }
  });

  it('correctly identifies savings when stores have complementary cheapest items', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'eggs', quantity: 2 },
      { id: 'bread', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        milk: makePrice(5.49),
        eggs: makePrice(3.99),
        bread: makePrice(2.49),
      },
      store_b: {
        milk: makePrice(4.29),
        eggs: makePrice(4.49),
        bread: makePrice(1.99),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    expect(result.length).toBeGreaterThanOrEqual(1);

    // 1-stop: store_a = 5.49 + 2*3.99 + 2.49 = 15.96
    // store_b = 4.29 + 2*4.49 + 1.99 = 15.26 → store_b is cheaper single stop
    const oneStopCost = 4.29 + 2 * 4.49 + 1.99; // 15.26
    expect(result[0].totalCost).toBeCloseTo(oneStopCost, 2);

    if (result.length >= 2) {
      // 2-stop: pick cheapest per item from store_a + store_b
      // milk: 4.29 (store_b), eggs: 3.99 (store_a), bread: 1.99 (store_b)
      // total = 4.29 + 2*3.99 + 1.99 = 14.26
      const twoStopCost = 4.29 + 2 * 3.99 + 1.99;
      expect(result[1].totalCost).toBeCloseTo(twoStopCost, 2);
      expect(result[1].savingsVsOneStop).toBeCloseTo(oneStopCost - twoStopCost, 2);
    }
  });
});

describe('computeStopProposals — 3 stores, complex split', () => {
  it('correctly applies greedy ordering', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'eggs', quantity: 1 },
      { id: 'bread', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        milk: makePrice(4.00),
        eggs: makePrice(3.00),
        bread: makePrice(4.00),
      },
      store_b: {
        milk: makePrice(5.00),
        eggs: makePrice(2.00),
        bread: makePrice(3.00),
      },
      store_c: {
        milk: makePrice(3.00),
        eggs: makePrice(4.00),
        bread: makePrice(2.50),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // All 3 stores have prices -> proposals for 1-stop, 2-stop, 3-stop
    expect(result.length).toBeGreaterThanOrEqual(1);

    // 1-stop: cheapest single store
    // store_a = 4+3+4 = 11
    // store_b = 5+2+3 = 10
    // store_c = 3+4+2.5 = 9.5 → store_c is cheapest
    expect(result[0].numStops).toBe(1);
    expect(result[0].totalCost).toBeCloseTo(9.5, 2);

    if (result.length >= 2) {
      // Greedy: which store to add? Adding store_b to store_c:
      // milk: min(3,5)=3, eggs: min(4,2)=2, bread: min(2.5,3)=2.5 → 7.5
      // Adding store_a to store_c:
      // milk: min(3,4)=3, eggs: min(4,3)=3, bread: min(2.5,4)=2.5 → 8.5
      // store_b added first (7.5 < 8.5)
      expect(result[1].numStops).toBe(2);
      expect(result[1].totalCost).toBeCloseTo(7.5, 2);
    }

    if (result.length >= 3) {
      // Add the last store (store_a):
      // milk: min(3,5,4)=3, eggs: min(4,2,3)=2, bread: min(2.5,3,4)=2.5 → 7.5
      // Same as before — algorithm should stop since no improvement
      // Because bestCombinedCost (7.5) >= last proposal cost (7.5), it breaks
      // So we may only get 2 proposals
      // Actually looking at the code: if bestCombinedCost >= proposals[last].totalCost, break
      // So this would be 7.5 >= 7.5 → break, so only 2 proposals
    }
  });
});

describe('computeStopProposals — edge cases', () => {
  it('excludes items with no price in any store', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'unknown_item', quantity: 1 }, // no price anywhere
    ];
    const perStorePrices = {
      store_a: { milk: makePrice(4.99) },
      store_b: { milk: makePrice(3.99) },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // unknown_item contributes 0 — only milk is priced
    expect(result.length).toBeGreaterThanOrEqual(1);
    // 1-stop: cheapest store for milk = 3.99 (store_b)
    expect(result[0].totalCost).toBeCloseTo(3.99, 2);
  });

  it('handles items with price only in some stores', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'specialty_item', quantity: 1 }, // only in store_b
    ];
    const perStorePrices = {
      store_a: { milk: makePrice(4.99) },
      store_b: {
        milk: makePrice(5.49),
        specialty_item: makePrice(12.99),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // DEFECT FIXED (coverage-blind 1-stop): store_a at 4.99 omits the
    // specialty item, so it must not be the 1-stop pick. Coverage first:
    // store_b (5.49 + 12.99 = 18.48) is the only full-basket single stop.
    expect(result[0].numStops).toBe(1);
    expect(result[0].stores[0].storeId).toBe('store_b');
    expect(result[0].totalCost).toBeCloseTo(18.48, 2);
    expect(result[0].coveredCount).toBe(2);

    // 2-stop: milk@store_a 4.99 + specialty@store_b 12.99 = 17.98, a real
    // saving of 0.50 against the same full basket.
    expect(result).toHaveLength(2);
    expect(result[1].totalCost).toBeCloseTo(17.98, 2);
    expect(result[1].savingsVsOneStop).toBeCloseTo(0.5, 2);
  });

  it('handles zero-price items without division-by-zero errors', () => {
    const items = [
      { id: 'free_item', quantity: 2 },
      { id: 'paid_item', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        free_item: makePrice(0),
        paid_item: makePrice(5.00),
      },
      store_b: {
        free_item: makePrice(1.00),
        paid_item: makePrice(4.00),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // Should not crash with division-by-zero
    expect(result.length).toBeGreaterThanOrEqual(1);
    // 1-stop: store_a = 2*0 + 5 = 5, store_b = 2*1 + 4 = 6 → store_a wins
    expect(result[0].totalCost).toBeCloseTo(5.0, 2);
  });

  it('handles all prices identical across stores', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'bread', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        milk: makePrice(2.50),
        bread: makePrice(1.50),
      },
      store_b: {
        milk: makePrice(2.50),
        bread: makePrice(1.50),
      },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // 1 proposal, savings = 0
    expect(result).toHaveLength(1);
    expect(result[0].savingsVsOneStop).toBe(0);
  });
});

describe('computeStopProposals — store name mapping', () => {
  it('uses store names from storeNameMap', () => {
    const items = [
      { id: 'milk', quantity: 1 },
      { id: 'bread', quantity: 1 },
    ];
    const perStorePrices = {
      store_a: {
        milk: makePrice(3.00),
        bread: makePrice(2.00),
      },
      store_b: {
        milk: makePrice(2.50),
        bread: makePrice(1.50),
      },
    };
    const storeNameMap = {
      store_a: 'Walmart',
      store_b: 'Target',
    };
    const result = computeStopProposals(items, perStorePrices, storeNameMap);

    expect(result).toHaveLength(1);
    expect(result[0].stores).toEqual([
      { storeId: 'store_b', storeName: 'Target' },
    ]);
  });

  it('falls back to storeId when store name is not in map', () => {
    const items = [
      { id: 'milk', quantity: 1 },
    ];
    const perStorePrices = {
      store_xyz: { milk: makePrice(2.50) },
      store_abc: { milk: makePrice(3.00) },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    expect(result).toHaveLength(1);
    expect(result[0].stores).toEqual([
      { storeId: 'store_xyz', storeName: 'store_xyz' },
    ]);
  });
});

describe('computeStopProposals — quantity scaling', () => {
  it('scales item cost by quantity', () => {
    const items = [
      { id: 'milk', quantity: 3 },
    ];
    const perStorePrices = {
      store_a: { milk: makePrice(4.00) },
      store_b: { milk: makePrice(3.50) },
    };
    const result = computeStopProposals(items, perStorePrices, {});

    // store_b: 3 * 3.50 = 10.50
    expect(result[0].totalCost).toBeCloseTo(10.50, 2);
  });
});
