/**
 * Trip Plan Tests — computeTripPlan.
 *
 * Direct unit tests for the pricing logic the paid tier charges for
 * (Goal 7 requirement — previously computeTripPlan was reached only
 * through the UI). Pure algorithm tests:
 *  - Empty items / empty store sets → zeroed shape
 *  - Zero relevant stores → same zeroed shape
 *  - Unpriced items land in unassigned with price: 0 (not dropped)
 *  - maxStops clamps via Math.min(maxStops, relevantStores.length)
 *  - Exact enumeration at ≤7 relevant stores vs greedy above 7
 *  - Greedy result no worse than the best single store (8-store case)
 *  - Savings = best single-store trip − optimized total, floored at 0
 *  - Quantity multiplies into totalCost and each stop's subtotal
 *
 * Run: npx jest __tests__/trip-plan.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import { computeTripPlan } from '../src/pricing/trip-plan';
import type { TripPlan } from '../src/pricing/trip-plan';
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

function makeItem(
  id: string,
  quantity = 1,
  unit = 'ea',
): { id: string; name: string; quantity: number; unit: string } {
  return { id, name: id, quantity, unit };
}

/** The zeroed TripPlan shape the early returns must produce. */
function expectZeroedShape(plan: TripPlan, expectedUnassigned: number): void {
  expect(plan.stops).toEqual([]);
  expect(plan.unassigned).toHaveLength(expectedUnassigned);
  expect(plan.totalCost).toBe(0);
  expect(plan.savings).toBe(0);
  expect(plan.numStops).toBe(0);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('computeTripPlan — empty inputs return the zeroed shape', () => {
  it('returns the zeroed shape for empty items and empty store set', () => {
    const plan = computeTripPlan([], {});
    expectZeroedShape(plan, 0);
  });

  it('returns the zeroed shape for empty items with stores present', () => {
    const perStorePrices = { store_a: { milk: makePrice(4.99) } };
    const plan = computeTripPlan([], perStorePrices);
    expectZeroedShape(plan, 0);
  });

  it('returns items as unassigned (price 0) when the store set is empty', () => {
    const items = [makeItem('milk', 2), makeItem('eggs', 1)];
    const plan = computeTripPlan(items, {});
    expectZeroedShape(plan, 2);
    expect(plan.unassigned).toEqual([
      { itemId: 'milk', itemName: 'milk', quantity: 2, price: 0, unit: 'ea', lineTotal: 0 },
      { itemId: 'eggs', itemName: 'eggs', quantity: 1, price: 0, unit: 'ea', lineTotal: 0 },
    ]);
  });

  it('returns the zeroed shape when availableStores is explicitly empty', () => {
    const items = [makeItem('milk')];
    const perStorePrices = { store_a: { milk: makePrice(4.99) } };
    const plan = computeTripPlan(items, perStorePrices, 5, []);
    expectZeroedShape(plan, 1);
  });
});

describe('computeTripPlan — zero relevant stores returns the same zeroed shape', () => {
  it('treats stores with no prices for any list item as irrelevant', () => {
    // Stores exist but price only items NOT on the list.
    const items = [makeItem('milk', 3)];
    const perStorePrices = {
      store_a: { bread: makePrice(2.49) },
      store_b: { cheese: makePrice(6.99) },
    };
    const plan = computeTripPlan(items, perStorePrices);
    expectZeroedShape(plan, 1);
    expect(plan.unassigned[0]).toEqual({
      itemId: 'milk',
      itemName: 'milk',
      quantity: 3,
      price: 0,
      unit: 'ea',
      lineTotal: 0,
    });
  });

  it('treats stores with empty price maps as irrelevant', () => {
    const items = [makeItem('milk')];
    const perStorePrices = { store_a: {}, store_b: {} };
    const plan = computeTripPlan(items, perStorePrices);
    expectZeroedShape(plan, 1);
  });
});

describe('computeTripPlan — unpriced items land in unassigned, not dropped', () => {
  it('assigns priced items and keeps unpriced items with price: 0', () => {
    const items = [makeItem('milk', 1), makeItem('caviar', 2, 'jar')];
    const perStorePrices = {
      store_a: { milk: makePrice(4.99) },
    };
    const plan = computeTripPlan(items, perStorePrices);

    expect(plan.stops).toHaveLength(1);
    expect(plan.stops[0].items.map((it) => it.itemId)).toEqual(['milk']);
    expect(plan.unassigned).toEqual([
      { itemId: 'caviar', itemName: 'caviar', quantity: 2, price: 0, unit: 'jar', lineTotal: 0 },
    ]);
    // Unpriced items contribute nothing to cost — but are not silently dropped.
    expect(plan.totalCost).toBeCloseTo(4.99);
  });

  it('preserves every unpriced item across a multi-store plan', () => {
    const items = [
      makeItem('milk'),
      makeItem('eggs'),
      makeItem('unicorn_dust'),
      makeItem('dragon_eggs'),
    ];
    const perStorePrices = {
      store_a: { milk: makePrice(4.0), eggs: makePrice(5.0) },
      store_b: { milk: makePrice(5.0), eggs: makePrice(3.0) },
    };
    const plan = computeTripPlan(items, perStorePrices);
    const unassignedIds = plan.unassigned.map((it) => it.itemId).sort();
    expect(unassignedIds).toEqual(['dragon_eggs', 'unicorn_dust']);
    for (const it of plan.unassigned) {
      expect(it.price).toBe(0);
    }
    // All 4 items accounted for: assigned + unassigned.
    const assignedCount = plan.stops.reduce((n, s) => n + s.items.length, 0);
    expect(assignedCount + plan.unassigned.length).toBe(4);
  });
});

describe('computeTripPlan — maxStops clamping (Math.min(maxStops, relevantStores.length))', () => {
  // Three stores, each uniquely cheapest for one item, so an unclamped
  // optimizer would want all three stops.
  const items = [makeItem('a'), makeItem('b'), makeItem('c')];
  const perStorePrices = {
    s1: { a: makePrice(1.0), b: makePrice(9.0), c: makePrice(9.0) },
    s2: { a: makePrice(9.0), b: makePrice(1.0), c: makePrice(9.0) },
    s3: { a: makePrice(9.0), b: makePrice(9.0), c: makePrice(1.0) },
  };

  it('never exceeds maxStops even when more stops would be cheaper', () => {
    const plan = computeTripPlan(items, perStorePrices, 2);
    expect(plan.numStops).toBeLessThanOrEqual(2);
    expect(plan.stops.length).toBeLessThanOrEqual(2);
    // Best 2-stop plan: two items at 1.00 plus one at 9.00 = 11.00.
    expect(plan.totalCost).toBeCloseTo(11.0);
  });

  it('clamps maxStops down to the relevant store count', () => {
    // maxStops 5 > 3 relevant stores → effective cap is 3; all three used.
    const plan = computeTripPlan(items, perStorePrices, 5);
    expect(plan.numStops).toBe(3);
    expect(plan.totalCost).toBeCloseTo(3.0);
  });

  it('maxStops of 1 degenerates to the best single store', () => {
    const plan = computeTripPlan(items, perStorePrices, 1);
    expect(plan.numStops).toBe(1);
    // Every single store totals 1 + 9 + 9 = 19.
    expect(plan.totalCost).toBeCloseTo(19.0);
  });
});

describe('computeTripPlan — exact enumeration (≤7 stores) vs greedy (>7)', () => {
  /**
   * Full-coverage fixture (every store prices every item, so subset cost
   * comparisons are apples-to-apples — see the coverage-blindness test below
   * for why that matters):
   *  - specialist stores s0..sN-1: item i at 1.00 in s_i, 5.00 elsewhere
   *  - store "gen": every item at 4.00 (the best generalist)
   */
  function buildFullCoveragePrices(specialists: number): {
    items: { id: string; name: string; quantity: number; unit: string }[];
    perStorePrices: Record<string, Record<string, PriceResult>>;
  } {
    const items = Array.from({ length: specialists }, (_, i) => makeItem(`item${i}`));
    const perStorePrices: Record<string, Record<string, PriceResult>> = { gen: {} };
    for (let i = 0; i < specialists; i++) {
      perStorePrices.gen[`item${i}`] = makePrice(4.0);
      perStorePrices[`s${i}`] = {};
    }
    for (let s = 0; s < specialists; s++) {
      for (let i = 0; i < specialists; i++) {
        perStorePrices[`s${s}`][`item${i}`] = makePrice(s === i ? 1.0 : 5.0);
      }
    }
    return { items, perStorePrices };
  }

  it('at 7 relevant stores the exact path finds the true optimum', () => {
    // 6 specialists + generalist = 7 relevant stores → exact enumeration.
    const { items, perStorePrices } = buildFullCoveragePrices(6);
    expect(Object.keys(perStorePrices)).toHaveLength(7);
    const plan = computeTripPlan(items, perStorePrices, 6);
    // Optimum with 6 allowed stops: all 6 specialists at 1.00 each = 6.00
    // (vs. generalist alone at 24.00).
    expect(plan.totalCost).toBeCloseTo(6.0);
    expect(plan.numStops).toBe(6);
    expect(plan.stops.map((s) => s.storeId).sort()).toEqual([
      's0', 's1', 's2', 's3', 's4', 's5',
    ]);
  });

  it('above 7 relevant stores the greedy path is no worse than the best single store', () => {
    // 7 specialists + generalist = 8 relevant stores → greedy fallback.
    const { items, perStorePrices } = buildFullCoveragePrices(7);
    const storeIds = Object.keys(perStorePrices);
    expect(storeIds).toHaveLength(8);

    // Compute the best single store from the fixture itself:
    // gen = 7 × 4.00 = 28.00; each specialist = 1.00 + 6 × 5.00 = 31.00.
    let bestSingleStoreCost = Infinity;
    for (const sid of storeIds) {
      const cost = items.reduce(
        (sum, it) => sum + perStorePrices[sid][it.id].price * it.quantity,
        0,
      );
      bestSingleStoreCost = Math.min(bestSingleStoreCost, cost);
    }
    expect(bestSingleStoreCost).toBeCloseTo(28.0);

    const plan = computeTripPlan(items, perStorePrices, 4);
    expect(plan.totalCost).toBeLessThanOrEqual(bestSingleStoreCost);
    expect(plan.numStops).toBeLessThanOrEqual(4);
    // Greedy must strictly improve while improvements exist: seeding gen and
    // adding any specialist saves 3.00/item, so it must beat gen-only here.
    expect(plan.totalCost).toBeLessThan(bestSingleStoreCost);
    // No item may be dropped: full-coverage fixture → nothing unassigned.
    const assignedCount = plan.stops.reduce((n, s) => n + s.items.length, 0);
    expect(assignedCount).toBe(items.length);
    expect(plan.unassigned).toEqual([]);
  });

  it('DEFECT FIXED: prefers subsets that cover more items; cost breaks ties', () => {
    // Regression test for the coverage-blindness defect found writing this
    // suite (recorded in GOAL_PROMPT_NOTES.md, Goal 7): subsets used to be
    // compared purely on totalCost while unassigned items cost 0, so a
    // subset covering FEWER items could win and silently drop items.
    const items = [makeItem('a'), makeItem('b')];
    const perStorePrices = {
      cheap_partial: { a: makePrice(1.0) },              // covers only a
      full: { a: makePrice(2.0), b: makePrice(2.0) },    // covers both
    };
    const plan = computeTripPlan(items, perStorePrices, 2);
    // Full coverage must win: a@cheap_partial 1.00 + b@full 2.00 = 3.00,
    // nothing unassigned. (The old behavior returned {cheap_partial} alone
    // at totalCost 1.00 with b dropped.)
    expect(plan.unassigned).toEqual([]);
    expect(plan.totalCost).toBeCloseTo(3.0);
    expect(plan.numStops).toBe(2);
    // One-stop baseline is the best FULL-coverage single store (4.00), so
    // the reported savings is honest: 4.00 - 3.00 = 1.00.
    expect(plan.savings).toBeCloseTo(1.0);
  });

  it('greedy stops adding stores once no candidate reduces cost', () => {
    // 8 stores with identical prices: adding stops never reduces cost,
    // so greedy must settle on a single stop.
    const items = [makeItem('a'), makeItem('b')];
    const perStorePrices: Record<string, Record<string, PriceResult>> = {};
    for (let i = 0; i < 8; i++) {
      perStorePrices[`s${i}`] = { a: makePrice(2.0), b: makePrice(3.0) };
    }
    const plan = computeTripPlan(items, perStorePrices, 5);
    expect(plan.numStops).toBe(1);
    expect(plan.totalCost).toBeCloseTo(5.0);
  });
});

describe('computeTripPlan — savings floors at 0', () => {
  it('reports savings 0 (not negative) when all stores price identically', () => {
    // worstSingleCost equals the optimized total → raw savings is 0;
    // Math.max(0, …) keeps it there.
    const items = [makeItem('milk', 2)];
    const perStorePrices = {
      store_a: { milk: makePrice(4.0) },
      store_b: { milk: makePrice(4.0) },
    };
    const plan = computeTripPlan(items, perStorePrices);
    expect(plan.savings).toBe(0);
    expect(plan.totalCost).toBeCloseTo(8.0);
  });

  it('never reports negative savings in any configuration', () => {
    const items = [makeItem('a', 1), makeItem('b', 3)];
    const perStorePrices = {
      s1: { a: makePrice(1.5), b: makePrice(2.25) },
      s2: { a: makePrice(1.5) },
    };
    const plan = computeTripPlan(items, perStorePrices, 1);
    expect(plan.savings).toBeGreaterThanOrEqual(0);
  });

  it('positive savings equals best single-store trip minus optimized total', () => {
    // One-stop baseline (same as stop-optimizer's savingsVsOneStop):
    // s1 = 5 + 2×2 = 9 (best single store); s2 = 3 + 4×2 = 11.
    // Optimized 2-stop: a@s2 3.00 + b@s1 2×2.00 = 7.00 → savings 2.00.
    const items = [makeItem('a', 1), makeItem('b', 2)];
    const perStorePrices = {
      s1: { a: makePrice(5.0), b: makePrice(2.0) },
      s2: { a: makePrice(3.0), b: makePrice(4.0) },
    };
    const plan = computeTripPlan(items, perStorePrices, 2);
    expect(plan.totalCost).toBeCloseTo(7.0);
    expect(plan.savings).toBeCloseTo(2.0);
  });
});

describe('computeTripPlan — quantity multiplies into totalCost and stop subtotals', () => {
  it('multiplies quantity into totalCost and each stop subtotal consistently', () => {
    const items = [makeItem('milk', 3), makeItem('eggs', 2)];
    const perStorePrices = {
      store_a: { milk: makePrice(4.0), eggs: makePrice(6.0) },
      store_b: { milk: makePrice(5.0), eggs: makePrice(3.0) },
    };
    const plan = computeTripPlan(items, perStorePrices, 2);

    // milk → store_a (4.00 × 3 = 12.00); eggs → store_b (3.00 × 2 = 6.00).
    expect(plan.totalCost).toBeCloseTo(18.0);
    const byStore = Object.fromEntries(plan.stops.map((s) => [s.storeId, s]));
    expect(byStore.store_a.subtotal).toBeCloseTo(12.0);
    expect(byStore.store_b.subtotal).toBeCloseTo(6.0);

    // Item entries carry unit price; subtotal = Σ price × quantity.
    expect(byStore.store_a.items[0]).toMatchObject({ itemId: 'milk', price: 4.0, quantity: 3 });
    expect(byStore.store_b.items[0]).toMatchObject({ itemId: 'eggs', price: 3.0, quantity: 2 });

    // totalCost is exactly the sum of stop subtotals.
    const subtotalSum = plan.stops.reduce((sum, s) => sum + s.subtotal, 0);
    expect(plan.totalCost).toBeCloseTo(subtotalSum);
  });

  it('quantity scales savings through the one-stop baseline too', () => {
    // rice(×4): s1 2.00, s2 5.00; beans(×2): s1 6.00, s2 3.00.
    // Baseline: s1 = 8 + 12 = 20 (vs s2 = 26). Optimized: 8 + 6 = 14.
    // Savings = 20 - 14 = 6.00 — the per-unit 3.00 gap on beans × 2.
    const items = [makeItem('rice', 4), makeItem('beans', 2)];
    const perStorePrices = {
      s1: { rice: makePrice(2.0), beans: makePrice(6.0) },
      s2: { rice: makePrice(5.0), beans: makePrice(3.0) },
    };
    const plan = computeTripPlan(items, perStorePrices);
    expect(plan.totalCost).toBeCloseTo(14.0);
    expect(plan.savings).toBeCloseTo(6.0);
  });
});
