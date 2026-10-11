/**
 * Price Store Merge Tests — loadPricesForAllStores.
 *
 * Tests the merge logic that converts perStorePrices (storeId → itemId → PriceResult)
 * into a flat prices map.
 *
 * Requires mocking of settings (pricingOptedIn gate) and registry (getAllCandidates).
 *
 * Run: npx jest __tests__/price-store-merge.test.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mock Dependencies BEFORE importing module under test ───────────────────

jest.mock('../src/config/settings', () => ({
  getSettings: () => ({
    pricingOptedIn: true,
  }),
}));

jest.mock('../src/pricing/registry', () => ({
  priceRegistry: {
    getAllCandidates: jest.fn(),
  },
}));

jest.mock('../src/pricing/crowdsourced', () => ({
  crowdsourcedAdapter: {},
}));

// ─── Imports (after mocks are set up) ────────────────────────────────────────

import { usePriceStore } from '../src/pricing/price-store';
import { priceRegistry } from '../src/pricing/registry';
import type { PriceResult } from '../src/pricing/types';
import { primaryOffer } from '../src/pricing/basket';

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

function mockRegistryForStore(
  storeId: string,
  items: { id: string; name: string; price: number }[],
): void {
  const map = new Map<string, PriceResult[]>();
  for (const item of items) {
    map.set(item.name, [makePrice(item.price)]);
  }
  (priceRegistry.getAllCandidates as any).mockImplementation(
    async (_names: string[], sid: string) => {
      if (sid === storeId) return map;
      return new Map();
    },
  );
}

function mockRegistryForStores(
  storeMap: Record<
    string,
    { id: string; name: string; price: number }[]
  >,
): void {
  (priceRegistry.getAllCandidates as any).mockImplementation(
    async (_names: string[], storeId: string) => {
      const items = storeMap[storeId];
      if (!items) return new Map();
      const map = new Map<string, PriceResult[]>();
      for (const item of items) {
        map.set(item.name, [makePrice(item.price)]);
      }
      return map;
    },
  );
}

// ─── Test Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset store state and mock calls before each test
  usePriceStore.getState().clearPrices();
  usePriceStore.getState().clearPerStorePrices();
  (priceRegistry.getAllCandidates as any).mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadPricesForAllStores — basic merge', () => {
  it('loads prices for multiple stores with different items into flat prices map', async () => {
    mockRegistryForStores({
      store_a: [
        { id: 'milk', name: 'Milk', price: 4.99 },
        { id: 'eggs', name: 'Eggs', price: 3.99 },
      ],
      store_b: [
        { id: 'bread', name: 'Bread', price: 2.49 },
        { id: 'butter', name: 'Butter', price: 5.49 },
      ],
    });

    const items = [
      { id: 'milk', name: 'Milk' },
      { id: 'eggs', name: 'Eggs' },
      { id: 'bread', name: 'Bread' },
      { id: 'butter', name: 'Butter' },
    ];

    await usePriceStore.getState().loadPricesForAllStores(items, ['store_a', 'store_b']);

    const state = usePriceStore.getState();

    // All items present in flat prices map
    expect(state.prices.milk).toBeDefined();
    expect(state.prices.milk!.price).toBeCloseTo(4.99, 2);
    expect(state.prices.eggs).toBeDefined();
    expect(state.prices.eggs!.price).toBeCloseTo(3.99, 2);
    expect(state.prices.bread).toBeDefined();
    expect(state.prices.bread!.price).toBeCloseTo(2.49, 2);
    expect(state.prices.butter).toBeDefined();
    expect(state.prices.butter!.price).toBeCloseTo(5.49, 2);

    // Per-store prices preserved independently
    expect(state.perStorePrices.store_a).toBeDefined();
    expect(state.perStorePrices.store_a.milk).toBeDefined();
    expect(state.perStorePrices.store_a.eggs).toBeDefined();
    expect(state.perStorePrices.store_a.bread).toBeUndefined();

    expect(state.perStorePrices.store_b).toBeDefined();
    expect(state.perStorePrices.store_b.bread).toBeDefined();
    expect(state.perStorePrices.store_b.butter).toBeDefined();
    expect(state.perStorePrices.store_b.milk).toBeUndefined();
  });
});

describe('loadPricesForAllStores — same item in multiple stores', () => {
  it('last store wins in flat prices map (documented behavior)', async () => {
    mockRegistryForStores({
      store_a: [
        { id: 'milk', name: 'Milk', price: 4.99 },
      ],
      store_b: [
        { id: 'milk', name: 'Milk', price: 3.49 },
      ],
    });

    const items = [{ id: 'milk', name: 'Milk' }];

    // Store order matters: store_b is last
    await usePriceStore.getState().loadPricesForAllStores(items, ['store_a', 'store_b']);

    const state = usePriceStore.getState();
    // Flat prices get the last store's price due to spread merge
    expect(state.prices.milk!.price).toBeCloseTo(3.49, 2);

    // Per-store still has both
    expect(primaryOffer(state.perStorePrices.store_a.milk)!.price).toBeCloseTo(4.99, 2);
    expect(primaryOffer(state.perStorePrices.store_b.milk)!.price).toBeCloseTo(3.49, 2);
  });
});

describe('loadPricesForAllStores — store with no prices', () => {
  it('skips stores that return no results', async () => {
    mockRegistryForStores({
      store_a: [
        { id: 'milk', name: 'Milk', price: 4.99 },
      ],
      store_b: [], // empty — no prices returned
    });

    const items = [{ id: 'milk', name: 'Milk' }];

    await usePriceStore.getState().loadPricesForAllStores(items, ['store_a', 'store_b']);

    const state = usePriceStore.getState();

    // store_a should be in perStorePrices
    expect(state.perStorePrices.store_a).toBeDefined();
    expect(state.perStorePrices.store_a.milk).toBeDefined();

    // store_b should NOT be in perStorePrices (empty results are skipped)
    expect(state.perStorePrices.store_b).toBeUndefined();
  });
});

describe('loadPricesForAllStores — empty items list', () => {
  it('loads nothing when items array is empty', async () => {
    // No need to mock — empty items means getAllCandidates is never called meaningfully
    await usePriceStore.getState().loadPricesForAllStores([], ['store_a']);

    const state = usePriceStore.getState();
    expect(Object.keys(state.prices)).toHaveLength(0);
    expect(Object.keys(state.perStorePrices)).toHaveLength(0);
  });
});

describe('getStoreIdsWithPrices — only stores with data', () => {
  it('returns only store IDs that have price entries', async () => {
    mockRegistryForStores({
      store_a: [
        { id: 'milk', name: 'Milk', price: 4.99 },
      ],
      store_b: [], // no data
      store_c: [
        { id: 'eggs', name: 'Eggs', price: 3.49 },
      ],
    });

    const items = [
      { id: 'milk', name: 'Milk' },
      { id: 'eggs', name: 'Eggs' },
    ];

    await usePriceStore.getState().loadPricesForAllStores(items, ['store_a', 'store_b', 'store_c']);

    const storeIds = usePriceStore.getState().getStoreIdsWithPrices();

    // store_b is skipped (no prices), only store_a and store_c
    expect(storeIds).toContain('store_a');
    expect(storeIds).toContain('store_c');
    expect(storeIds).not.toContain('store_b');
    expect(storeIds).toHaveLength(2);
  });
});

describe('loadPricesForAllStores — additive loading', () => {
  it('multiple calls accumulate results without clearing previous data', async () => {
    // First call: load store_a data
    mockRegistryForStores({
      store_a: [
        { id: 'milk', name: 'Milk', price: 4.99 },
      ],
    });

    await usePriceStore.getState().loadPricesForAllStores(
      [{ id: 'milk', name: 'Milk' }],
      ['store_a'],
    );

    expect(usePriceStore.getState().prices.milk).toBeDefined();
    expect(Object.keys(usePriceStore.getState().perStorePrices)).toContain('store_a');

    // Second call: load store_b data
    mockRegistryForStores({
      store_b: [
        { id: 'bread', name: 'Bread', price: 2.49 },
      ],
    });

    await usePriceStore.getState().loadPricesForAllStores(
      [{ id: 'bread', name: 'Bread' }],
      ['store_b'],
    );

    const state = usePriceStore.getState();
    // Previous data intact
    expect(state.prices.milk).toBeDefined();
    expect(state.prices.milk!.price).toBeCloseTo(4.99, 2);
    // New data present
    expect(state.prices.bread).toBeDefined();
    expect(state.prices.bread!.price).toBeCloseTo(2.49, 2);
    // Both stores in perStorePrices
    expect(state.perStorePrices.store_a).toBeDefined();
    expect(state.perStorePrices.store_b).toBeDefined();
  });
});

describe('loadPricesForAllStores — perStorePrices granularity', () => {
  it('each store has independently accessible prices', async () => {
    mockRegistryForStores({
      store_walmart: [
        { id: 'milk', name: 'Milk', price: 4.99 },
        { id: 'eggs', name: 'Eggs', price: 3.99 },
      ],
      store_target: [
        { id: 'milk', name: 'Milk', price: 5.49 },
        { id: 'bread', name: 'Bread', price: 2.49 },
      ],
      store_wegmans: [
        { id: 'eggs', name: 'Eggs', price: 2.99 },
        { id: 'butter', name: 'Butter', price: 4.49 },
      ],
    });

    const items = [
      { id: 'milk', name: 'Milk' },
      { id: 'eggs', name: 'Eggs' },
      { id: 'bread', name: 'Bread' },
      { id: 'butter', name: 'Butter' },
    ];

    await usePriceStore.getState().loadPricesForAllStores(
      items,
      ['store_walmart', 'store_target', 'store_wegmans'],
    );

    const psp = usePriceStore.getState().perStorePrices;

    // Walmart: milk + eggs
    expect(Object.keys(psp.store_walmart)).toEqual(['milk', 'eggs']);
    expect(primaryOffer(psp.store_walmart.milk)!.price).toBeCloseTo(4.99, 2);
    expect(primaryOffer(psp.store_walmart.eggs)!.price).toBeCloseTo(3.99, 2);

    // Target: milk + bread
    expect(Object.keys(psp.store_target)).toEqual(['milk', 'bread']);
    expect(primaryOffer(psp.store_target.milk)!.price).toBeCloseTo(5.49, 2);
    expect(primaryOffer(psp.store_target.bread)!.price).toBeCloseTo(2.49, 2);

    // Wegmans: eggs + butter
    expect(Object.keys(psp.store_wegmans)).toEqual(['eggs', 'butter']);
    expect(primaryOffer(psp.store_wegmans.eggs)!.price).toBeCloseTo(2.99, 2);
    expect(primaryOffer(psp.store_wegmans.butter)!.price).toBeCloseTo(4.49, 2);
  });
});

describe('loadPricesForAllStores — error handling', () => {
  it('sets error when getAllCandidates throws', async () => {
    (priceRegistry.getAllCandidates as any).mockRejectedValue(
      new Error('Network failure'),
    );

    const items = [{ id: 'milk', name: 'Milk' }];

    await usePriceStore.getState().loadPricesForAllStores(items, ['store_a']);

    const state = usePriceStore.getState();
    expect(state.error).toContain('Network failure');
  });
});
