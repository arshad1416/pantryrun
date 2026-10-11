/**
 * Prices this device records itself — crowd submissions and flyer scans.
 *
 *  1. Seed/demo prices: never blended with a real report, never present in
 *     a release build; manual entry uses the app's store IDs.
 *  2. Persistence: submissions and scans survive a restart (a fresh adapter
 *     instance), stored encrypted — never as plaintext — and are erased by
 *     "Clear Local Prices" / "Delete All Data".
 *  3. Flyer scans match like the live feeds and carry their package size.
 *
 * Run: npx jest __tests__/local-price-records.test.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as SecureStore from 'expo-secure-store';
import { CrowdsourcedAdapter } from '../src/pricing/crowdsourced';
import { FlyerScanAdapter } from '../src/pricing/flyer-scan';
import { clearLocalPriceRecords, LOCAL_PRICE_ALIASES } from '../src/pricing/local-price-records';
import { storeIdFromName } from '../src/pricing/live-prices';
import { lineCost } from '../src/pricing/basket';
import type { ScannedFlyerPrice } from '../src/pricing/flyer-types';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await clearLocalPriceRecords();
});

/** Every secure-store value under the local price aliases, concatenated. */
async function storedText(): Promise<string> {
  let out = '';
  for (const alias of Object.values(LOCAL_PRICE_ALIASES)) {
    const n = parseInt((await SecureStore.getItemAsync(`${alias}.n`)) ?? '0', 10);
    for (let i = 0; i < n; i++) out += (await SecureStore.getItemAsync(`${alias}.${i}`)) ?? '';
  }
  return out;
}

const submission = (price: number, over: Record<string, unknown> = {}) => ({
  itemName: 'Milk', storeId: 'no-frills', storeName: 'No Frills', price, unit: 'L', quantity: 4, submittedBy: 'member-1', ...over,
});

describe('1. seed / demo prices', () => {
  it("a real report replaces the seeds instead of blending with them", async () => {
    const dev = new CrowdsourcedAdapter({ seedDemo: true });
    const seeded = await dev.getPrice('Milk', 'no-frills');
    expect(seeded).toMatchObject({ price: 3.89, isDemo: true });

    await dev.submitPrice(submission(2.99));
    const pr = await dev.getPrice('Milk', 'no-frills');
    expect(pr?.price).toBe(2.99);
    expect(pr?.isDemo).toBeUndefined();
    expect(pr?.confidence).toBe('estimated'); // one real report, not "1 real + 1 seed"
  });

  it('a release build has no seed prices or seed stores', async () => {
    const release = new CrowdsourcedAdapter({ seedDemo: false });
    expect(await release.getPrice('Milk', 'no-frills')).toBeNull();
    expect(await release.getAvailableStores()).toEqual([]);
  });

  it('the default follows the build: __DEV__ false → no seeds, true → seeds', async () => {
    const g = global as unknown as { __DEV__?: boolean };
    const before = g.__DEV__;
    try {
      g.__DEV__ = false;
      expect(await new CrowdsourcedAdapter().getPrice('Milk', 'no-frills')).toBeNull();
      g.__DEV__ = true;
      expect((await new CrowdsourcedAdapter().getPrice('Milk', 'no-frills'))?.isDemo).toBe(true);
    } finally {
      g.__DEV__ = before;
    }
  });

  it('manual price entry uses the app store ID ("No Frills" → no-frills)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'ItemEditScreen.tsx'), 'utf8');
    expect(src).toMatch(/storeId:\s*storeIdFromName\(priceStoreInput\)/);
    expect(src).not.toMatch(/replace\(\/\\s\+\/g,\s*'_'\)/);
    expect(storeIdFromName('No Frills')).toBe('no-frills');
  });
});

describe('2. persistence', () => {
  it('crowd submissions survive a restart, encrypted at rest', async () => {
    await new CrowdsourcedAdapter({ seedDemo: false, persist: true }).submitPrice(submission(2.99, { itemName: 'Jamaican Patties' }));
    const afterRestart = new CrowdsourcedAdapter({ seedDemo: false, persist: true });
    expect((await afterRestart.getPrice('Jamaican Patties', 'no-frills'))?.price).toBe(2.99);
    expect(await afterRestart.getAvailableStores()).toEqual([{ storeId: 'no-frills', storeName: 'No Frills' }]);

    const text = await storedText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/Jamaican|Patties|No Frills|2\.99/);
  });

  it('seeds are never written to disk', async () => {
    const dev = new CrowdsourcedAdapter({ seedDemo: true, persist: true });
    await dev.submitPrice(submission(2.99));
    const afterRestart = new CrowdsourcedAdapter({ seedDemo: false, persist: true });
    expect(await afterRestart.getPrice('Bananas', 'no-frills')).toBeNull();
    expect((await afterRestart.getPrice('Milk', 'no-frills'))?.price).toBe(2.99);
  });

  it('flyer scans survive a restart', async () => {
    await new FlyerScanAdapter({ persist: true }).submitScannedPrices([scan({ itemName: 'Neilson 2% Milk', unit: 'L', quantity: 4, price: 5.49 })]);
    const afterRestart = new FlyerScanAdapter({ persist: true });
    expect((await afterRestart.getPrice('milk', 'no-frills'))?.price).toBe(5.49);
    expect(await storedText()).not.toMatch(/Neilson/);
  });

  it('"Clear Local Prices" / "Delete All Data" erase what is on disk', async () => {
    await new CrowdsourcedAdapter({ seedDemo: false, persist: true }).submitPrice(submission(2.99));
    await new FlyerScanAdapter({ persist: true }).submitScannedPrices([scan({})]);
    const { usePriceStore } = await import('../src/pricing/price-store');
    usePriceStore.getState().clearPrices();
    await new Promise((r) => setTimeout(r, 0));
    await clearLocalPriceRecords(); // settles the fire-and-forget clear
    expect(await storedText()).toBe('');
    expect(await new CrowdsourcedAdapter({ seedDemo: false, persist: true }).getPrice('Milk', 'no-frills')).toBeNull();
    expect(await new FlyerScanAdapter({ persist: true }).getPrice('milk', 'no-frills')).toBeNull();
  });
});

function scan(over: Partial<ScannedFlyerPrice>): ScannedFlyerPrice {
  return {
    itemName: 'Neilson 2% Milk 4 L', storeId: 'no-frills', storeName: 'No Frills', price: 5.49,
    unit: 'each', quantity: 1, scannedAt: Date.now(), validTo: Date.now() + 5 * DAY, confidence: 0.9, ...over,
  };
}

describe('3. flyer-scan matching and pack sizes', () => {
  it('matches like the live feeds, not by exact lowercased name', async () => {
    const a = new FlyerScanAdapter();
    await a.submitScannedPrices([scan({ itemName: 'Coconut Milk 400 mL', price: 1.49 }), scan({})]);
    const pr = await a.getPrice('milk', 'no-frills');
    expect(pr?.matchedName).toBe('Neilson 2% Milk 4 L');
    expect(pr?.validTo).toBeGreaterThan(Date.now());
  });

  it('carries the package size from the scan or the product name', async () => {
    const a = new FlyerScanAdapter();
    await a.submitScannedPrices([
      scan({}),
      scan({ itemName: 'Large Eggs', unit: 'pcs', quantity: 12, price: 3.99 }),
      scan({ itemName: 'Ground Beef', unit: 'lb', quantity: 1, price: 4.99 }),
    ]);
    const milk = (await a.getPrice('milk', 'no-frills'))!;
    expect(milk).toMatchObject({ packageSize: 4, unit: 'L' });
    expect(lineCost({ quantity: 4, unit: 'L' }, milk).cost).toBe(5.49);
    const eggs = (await a.getPrice('eggs', 'no-frills'))!;
    expect(lineCost({ quantity: 12, unit: 'pcs' }, eggs).cost).toBe(3.99);
    const beef = (await a.getPrice('ground beef', 'no-frills'))!;
    expect(beef.pricingBasis).toBe('measure');
    expect(lineCost({ quantity: 2, unit: 'lb' }, beef).cost).toBe(9.98);
  });
});
