/**
 * Price store — refresh correctness.
 *
 *  - An offer that disappears on refresh is removed, not kept as a cached price.
 *  - Refreshing some items leaves other items' prices alone.
 *  - An older in-flight response cannot overwrite a newer edit.
 *  - A price edit reaches perStorePrices (what every comparison reads) and
 *    bumps priceDataVersion.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../src/config/settings', () => ({
  getSettings: () => ({ pricingOptedIn: true }),
}));

jest.mock('../src/pricing/registry', () => ({
  priceRegistry: {
    getAllPrices: jest.fn(),
    getPrice: jest.fn(),
  },
}));

jest.mock('../src/pricing/crowdsourced', () => ({
  crowdsourcedAdapter: { submitPrice: jest.fn(async () => undefined) },
}));

import { usePriceStore } from '../src/pricing/price-store';
import { priceRegistry } from '../src/pricing/registry';
import type { PriceResult } from '../src/pricing/types';

function pr(price: number, storeId = 's'): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: { adapterId: 'test', tier: 'crowd', storeId, storeName: storeId },
    timestamp: Date.now(),
    confidence: 'recent',
  };
}

const getAllPrices = priceRegistry.getAllPrices as unknown as jest.Mock<
  (names: string[], storeId: string) => Promise<Map<string, PriceResult>>
>;
const getPrice = priceRegistry.getPrice as unknown as jest.Mock<
  (name: string, storeId: string) => Promise<PriceResult | null>
>;

beforeEach(() => {
  usePriceStore.getState().clearPrices();
  usePriceStore.getState().clearPerStorePrices();
  getAllPrices.mockReset();
  getPrice.mockReset();
});

describe('refresh semantics', () => {
  it('an offer that disappears on refresh does not survive as an available price', async () => {
    getAllPrices.mockResolvedValueOnce(new Map([['Milk', pr(4.99)]]));
    await usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);
    expect(usePriceStore.getState().perStorePrices.s?.milk?.price).toBe(4.99);

    getAllPrices.mockResolvedValueOnce(new Map());
    await usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);
    expect(usePriceStore.getState().perStorePrices.s).toBeUndefined();
    expect(usePriceStore.getState().prices.milk).toBeUndefined();
  });

  it('HISTORICAL PROBE: refreshing only stale items used to wipe the store’s other prices', async () => {
    // Old behaviour: perStorePrices[store] was replaced wholesale by the
    // partial result, silently dropping every item not in the refresh batch.
    getAllPrices.mockResolvedValueOnce(new Map([['Milk', pr(4.99)], ['Eggs', pr(3.49)]]));
    await usePriceStore.getState().loadPricesForAllStores(
      [{ id: 'milk', name: 'Milk' }, { id: 'eggs', name: 'Eggs' }],
      ['s'],
    );
    getAllPrices.mockResolvedValueOnce(new Map([['Milk', pr(4.49)]]));
    await usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);

    const s = usePriceStore.getState().perStorePrices.s!;
    expect(s.milk!.price).toBe(4.49);
    expect(s.eggs!.price).toBe(3.49);
  });

  it('a store whose lookup failed keeps its previous prices (failure is not "no offer")', async () => {
    getAllPrices.mockResolvedValueOnce(new Map([['Milk', pr(4.99)]]));
    await usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);
    getAllPrices.mockRejectedValueOnce(new Error('offline'));
    await usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);
    expect(usePriceStore.getState().perStorePrices.s?.milk?.price).toBe(4.99);
    expect(usePriceStore.getState().error).toBe('offline');
  });
});

describe('ordering', () => {
  it('an older in-flight response cannot overwrite a newer edit', async () => {
    let releaseSlow!: (m: Map<string, PriceResult>) => void;
    getAllPrices.mockImplementationOnce(
      () => new Promise<Map<string, PriceResult>>((resolve) => { releaseSlow = resolve; }),
    );
    const slow = usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);

    // The user edits the price while the slow lookup is still running.
    getPrice.mockResolvedValueOnce(pr(3.99));
    await usePriceStore.getState().loadSinglePrice('milk', 'Milk', 's');
    expect(usePriceStore.getState().perStorePrices.s?.milk?.price).toBe(3.99);

    releaseSlow(new Map([['Milk', pr(5.99)]]));
    await slow;
    expect(usePriceStore.getState().perStorePrices.s?.milk?.price).toBe(3.99);
  });

  it('a response that started before a full refresh is dropped', async () => {
    let releaseSlow!: (m: Map<string, PriceResult>) => void;
    getAllPrices.mockImplementationOnce(
      () => new Promise<Map<string, PriceResult>>((resolve) => { releaseSlow = resolve; }),
    );
    const slow = usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);
    getAllPrices.mockResolvedValueOnce(new Map());
    await usePriceStore.getState().refreshAllPrices([{ id: 'milk', name: 'Milk' }], ['s']);
    releaseSlow(new Map([['Milk', pr(5.99)]]));
    await slow;
    expect(usePriceStore.getState().perStorePrices.s).toBeUndefined();
  });
});

describe('price edits', () => {
  it('HISTORICAL PROBE: a logged price used to update only the flat map, never the comparison', async () => {
    getAllPrices.mockResolvedValueOnce(new Map([['Milk', pr(4.99)]]));
    await usePriceStore.getState().loadPricesForAllStores([{ id: 'milk', name: 'Milk' }], ['s']);
    const v0 = usePriceStore.getState().priceDataVersion;

    getPrice.mockResolvedValueOnce(pr(3.49));
    await usePriceStore.getState().submitCrowdPrice(
      { itemName: 'Milk', storeId: 's', storeName: 's', price: 3.49, unit: 'L', quantity: 1, submittedBy: 'me' },
      'milk',
      'Milk',
    );
    const state = usePriceStore.getState();
    expect(state.perStorePrices.s!.milk!.price).toBe(3.49);
    expect(state.priceDataVersion).toBeGreaterThan(v0);
  });

  it('maxStops is clamped to 1..3', () => {
    usePriceStore.getState().setMaxStops(7);
    expect(usePriceStore.getState().maxStops).toBe(3);
    usePriceStore.getState().setMaxStops(0);
    expect(usePriceStore.getState().maxStops).toBe(1);
    usePriceStore.getState().setMaxStops(3);
  });
});
