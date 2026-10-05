/**
 * Live prices — the scraper's Turso data, served by the relay.
 *
 * The HTTP layer (fetch) is faked; everything above it is real: relay
 * client + auth header, region snapshots, row → PriceResult mapping,
 * on-device matching, store discovery and the basket planner.
 *
 *  1. Requests: one region per feed, Bearer relayToken, no item names
 *  2. Flyer rows: sale, own window (date-only stays a date), package size,
 *     per-lb, multi-buy, ended offers skipped before matching
 *  3. Shelf rows: scraped (usable, never verified), sale vs regular,
 *     weighed goods, stale rows dropped, scraper store IDs
 *  4. Failure: last-known prices marked refreshFailedAt, status for the
 *     banner; 503 → not configured
 *  5. Waterdown basket planned end to end from relay rows
 *
 * Run: npx jest __tests__/live-prices.test.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

let mockSettings: Record<string, unknown> = {};
jest.mock('../src/config/settings', () => ({ getSettings: () => mockSettings }));
jest.mock('../src/identity/enroll', () => ({ getRelayToken: async () => 'relay-token-abc' }));

import {
  _resetLivePrices,
  flyerDealToPriceResult,
  getLivePriceStatus,
  loadFlyerDeals,
  packageFromName,
  refreshLivePrices,
  shelfPriceToPriceResult,
  type FlyerDealRow,
  type ShelfPriceRow,
  type Snapshot,
} from '../src/pricing/live-prices';
import { flippDealsAdapter } from '../src/pricing/flipp-deals-adapter';
import { storePricesAdapter } from '../src/pricing/store-prices-adapter';
import { discoverStores } from '../src/pricing/store-discovery';
import { adapterRequiresHash } from '../src/pricing/privacy';
import { analyzeBasket, solvePlan, type BasketItem, type StoreOffers } from '../src/pricing/basket';
import { assessOffer, localDate } from '../src/pricing/eligibility';
import type { PriceResult } from '../src/pricing/types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const today = localDate(NOW, 'America/Toronto');
const inDays = (n: number) => localDate(NOW + n * DAY, 'America/Toronto');
const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ─── Fake relay ─────────────────────────────────────────────────────────────

let dealRows: FlyerDealRow[] = [];
let shelfRows: ShelfPriceRow[] = [];
let relayStatus = 200;
let requests: { url: string; auth: string | undefined }[] = [];
const realFetch = global.fetch;

beforeEach(() => {
  _resetLivePrices();
  mockSettings = { relayUrl: 'wss://relay.example.com', relayPort: 8080, flippFsa: 'L0R 2H4' };
  relayStatus = 200;
  requests = [];
  dealRows = [];
  shelfRows = [];
  global.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    requests.push({ url, auth: init?.headers?.Authorization });
    const kind = url.includes('/api/prices/deals') ? 'deals' : 'shelf';
    if (relayStatus !== 200) return { ok: false, status: relayStatus, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ kind, fsa: 'L0R', fetchedAt: new Date(NOW).toISOString(), rows: kind === 'deals' ? dealRows : shelfRows }),
    };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

function deal(over: Partial<FlyerDealRow>): FlyerDealRow {
  return { merchant: 'Fortinos', name: 'Item', price: '1.00', price_real: 1, image_url: null, valid_from: today, valid_to: inDays(5), ...over };
}

function shelf(over: Partial<ShelfPriceRow>): ShelfPriceRow {
  return {
    store_id: 'nofrills', store_name: 'No Frills', name: 'Item', price: '1.00', price_real: 1,
    unit: 'each', unit_price_real: null, is_on_sale: 0, sale_price: null, was_price: null,
    scraped_at: sqliteUtc(NOW - 6 * 60 * 60 * 1000), ...over,
  };
}

const snapOf = <T,>(rows: T[], extra: Partial<Snapshot<T>> = {}): Snapshot<T> =>
  ({ fsa: 'L0R', rows, fetchedAt: NOW, loadedAt: NOW, ...extra });

// ─── 1. Requests ────────────────────────────────────────────────────────────

describe('1. relay requests', () => {
  it('ask for a region with the device token — never an item name', async () => {
    dealRows = [deal({ name: 'Green Seedless Grapes' })];
    shelfRows = [shelf({ name: 'Lactantia Lactose Free Milk 2 L' })];
    await flippDealsAdapter.getPrices(['green grapes', 'lactose-free milk'], 'fortinos');
    await storePricesAdapter.getPrices(['green grapes', 'lactose-free milk'], 'no-frills');

    expect(requests.map((r) => r.url)).toEqual([
      'https://relay.example.com:8080/api/prices/deals?fsa=L0R',
      'https://relay.example.com:8080/api/prices/shelf?fsa=L0R',
    ]);
    for (const r of requests) {
      expect(r.auth).toBe('Bearer relay-token-abc');
      expect(r.url).not.toMatch(/grape|milk/i);
    }
    // Matching is on-device, so the registry may hand these adapters plaintext.
    expect(adapterRequiresHash('flipp-deals')).toBe(false);
    expect(adapterRequiresHash('store-prices')).toBe(false);
  });

  it('reuses a region snapshot until refreshed', async () => {
    await loadFlyerDeals('L0R');
    await loadFlyerDeals('L0R');
    expect(requests).toHaveLength(1);
    await refreshLivePrices('L0R');
    expect(requests).toHaveLength(3); // deals + shelf, forced
  });

  it('a bad FSA falls back to Waterdown (L0R)', async () => {
    mockSettings.flippFsa = 'nonsense';
    await flippDealsAdapter.getAvailableStores();
    expect(requests[0].url).toContain('fsa=L0R');
  });

  it('no relay → unavailable and nothing fetched', async () => {
    mockSettings.relayUrl = '';
    expect(flippDealsAdapter.isAvailable()).toBe(false);
    expect(storePricesAdapter.isAvailable()).toBe(false);
    expect(await discoverStores()).toEqual(expect.not.arrayContaining([expect.objectContaining({ storeId: 'fortinos' })]));
    expect(requests).toHaveLength(0);
  });
});

// ─── 2. Flyer rows ──────────────────────────────────────────────────────────

describe('2. flyer deal → PriceResult', () => {
  it('is a sale with the flyer window; a date-only end stays a date', () => {
    const pr = flyerDealToPriceResult(deal({ name: 'Neilson 2% Milk 4 L', price: '5.49', price_real: 5.49, valid_to: '2026-10-08' }), snapOf([]))!;
    expect(pr).toMatchObject({
      price: 5.49,
      offerType: 'sale',
      validThroughDate: '2026-10-08',
      matchedName: 'Neilson 2% Milk 4 L',
      packageSize: 4,
      unit: 'L',
      pricingBasis: 'package',
      source: { adapterId: 'flipp-deals', tier: 'flyer', storeId: 'fortinos', storeName: 'Fortinos' },
    });
    expect(pr.validTo).toBeUndefined();
  });

  it('an end with a time becomes an instant', () => {
    const pr = flyerDealToPriceResult(deal({ valid_to: '2026-10-08T23:59:59-04:00' }), snapOf([]))!;
    expect(pr.validTo).toBe(Date.parse('2026-10-08T23:59:59-04:00'));
    expect(pr.validThroughDate).toBeUndefined();
  });

  it('per-lb produce is a measure rate; "2/$5" is a multi-buy', () => {
    const grapes = flyerDealToPriceResult(deal({ name: 'Green Seedless Grapes', price: '1.99/lb', price_real: 1.99 }), snapOf([]))!;
    expect(grapes).toMatchObject({ unit: 'lb', pricingBasis: 'measure' });
    const soup = flyerDealToPriceResult(deal({ name: 'Campbell’s Soup 284 mL', price: '2/$5', price_real: null }), snapOf([]))!;
    expect(soup.price).toBeCloseTo(2.5);
    expect(soup.multiBuy).toEqual({ groupSize: 2, groupPrice: 5, requiresFullGroup: false });
  });

  it('package sizes come from the name; multipacks are not guessed', () => {
    expect(packageFromName('Lactantia Lactose Free Milk 2 L')).toEqual({ packageSize: 2, unit: 'L' });
    expect(packageFromName('Old Cheddar 400 g')).toEqual({ packageSize: 400, unit: 'g' });
    expect(packageFromName('Coca-Cola 12 x 355 mL')).toBeNull();
    expect(packageFromName('Jamaican Beef Patties')).toBeNull();
  });

  it('ended offers are skipped before matching, so they cannot shadow a current one', async () => {
    dealRows = [
      deal({ name: 'Green Seedless Grapes', price: '1.49', price_real: 1.49, valid_to: inDays(-1) }),
      deal({ name: 'Green Seedless Grapes', price: '2.99', price_real: 2.99, valid_to: inDays(3) }),
    ];
    const pr = await flippDealsAdapter.getPrice('green grapes', 'fortinos');
    expect(pr?.price).toBe(2.99);
  });

  it('matches whole words and respects variants downstream', async () => {
    dealRows = [deal({ name: 'Buttermilk 1 L' }), deal({ name: 'Red Seedless Grapes' })];
    expect(await flippDealsAdapter.getPrice('milk', 'fortinos')).toBeNull();
    const red = await flippDealsAdapter.getPrice('grapes', 'fortinos');
    // "grapes" matches; "green grapes" is rejected later by eligibility on matchedName
    expect(red?.matchedName).toBe('Red Seedless Grapes');
    expect(assessOffer(red!, { name: 'green grapes' }, { now: NOW }).eligible).toBe(false);
  });
});

// ─── 3. Shelf rows ──────────────────────────────────────────────────────────

describe('3. shelf price → PriceResult', () => {
  it('is scraped: usable but never verified', () => {
    const pr = shelfPriceToPriceResult(shelf({ name: 'Lactantia Lactose Free Milk 2 L', price: '6.49', price_real: 6.49 }), snapOf([]), NOW)!;
    expect(pr).toMatchObject({ offerType: 'regular', source: { tier: 'scraping', storeId: 'no-frills' }, packageSize: 2, unit: 'L' });
    const verdict = assessOffer(pr, { name: 'lactose-free milk' }, { now: NOW });
    expect(verdict.eligible).toBe(true);
    expect(verdict.verified).toBe(false);
  });

  it('a sale row carries the sale price and the regular price', () => {
    const pr = shelfPriceToPriceResult(shelf({ price: '7.99', price_real: 7.99, is_on_sale: 1, sale_price: 5.99, was_price: 7.99 }), snapOf([]), NOW)!;
    expect(pr.price).toBe(5.99);
    expect(pr.offerType).toBe('sale');
    expect(pr.saleInfo).toMatchObject({ salePrice: 5.99, regularPrice: 7.99, savingsPercent: 25 });
  });

  it('weighed goods use the per-kg rate', () => {
    const pr = shelfPriceToPriceResult(shelf({ name: 'Bananas', price: '0.38', price_real: 0.38, unit: 'kg', unit_price_real: 1.52 }), snapOf([]), NOW)!;
    expect(pr).toMatchObject({ price: 1.52, unit: 'kg', pricingBasis: 'measure' });
  });

  it('drops rows scraped more than 7 days ago or with no price', () => {
    expect(shelfPriceToPriceResult(shelf({ scraped_at: sqliteUtc(NOW - 8 * DAY) }), snapOf([]), NOW)).toBeNull();
    expect(shelfPriceToPriceResult(shelf({ price: '', price_real: null }), snapOf([]), NOW)).toBeNull();
  });

  it('scraper store IDs map to the app\'s', async () => {
    shelfRows = [shelf({ store_id: 'nofrills', store_name: 'No Frills' }), shelf({ store_id: 'foodbasics', store_name: '' })];
    const stores = await storePricesAdapter.getAvailableStores();
    expect(stores.map((s) => s.storeId).sort()).toEqual(['food-basics', 'no-frills']);
  });
});

// ─── 4. Failure ─────────────────────────────────────────────────────────────

describe('4. when the relay fails', () => {
  it('keeps last-known prices, marked refreshFailedAt, and reports it', async () => {
    dealRows = [deal({ name: 'Green Seedless Grapes', price: '2.99', price_real: 2.99 })];
    await flippDealsAdapter.getPrice('green grapes', 'fortinos');
    expect(getLivePriceStatus().state).toBe('ok');

    relayStatus = 502;
    await refreshLivePrices('L0R');
    const pr = await flippDealsAdapter.getPrice('green grapes', 'fortinos');
    expect(pr?.price).toBe(2.99);
    expect(pr?.refreshFailedAt).toBeGreaterThan(0);
    expect(getLivePriceStatus()).toMatchObject({ state: 'failed', detail: 'Live prices unavailable — showing last known.' });
    // A failed refresh is never verified evidence.
    expect(assessOffer(pr!, { name: 'green grapes' }, { now: NOW }).verified).toBe(false);
  });

  it('503 (relay has no Turso settings) is "not configured", not a failure', async () => {
    relayStatus = 503;
    expect(await flippDealsAdapter.getPrices(['milk'], 'fortinos')).toEqual(new Map());
    expect(getLivePriceStatus().state).toBe('not_configured');
  });
});

// ─── 5. Waterdown basket from relay rows ────────────────────────────────────

describe('5. Waterdown weekly basket from the scraper feeds', () => {
  it('discovers stores from both feeds and plans a complete 2-stop basket', async () => {
    dealRows = [
      deal({ merchant: 'Fortinos', name: 'Tastee Jamaican Beef Patties', price: '4.49', price_real: 4.49 }),
      deal({ merchant: 'Fortinos', name: 'Red Seedless Grapes', price: '1.49/lb', price_real: 1.49 }),
    ];
    shelfRows = [
      shelf({ store_name: 'Food Basics', store_id: 'foodbasics', name: 'Green Seedless Grapes 907 g', price: '3.49', price_real: 3.49 }),
      shelf({ store_name: 'Food Basics', store_id: 'foodbasics', name: 'Lactantia Lactose Free Milk 2 L', price: '5.99', price_real: 5.99 }),
      shelf({ store_name: 'Food Basics', store_id: 'foodbasics', name: 'Wonder White Bread 675 g', price: '2.19', price_real: 2.19 }),
      shelf({ store_name: 'No Frills', store_id: 'nofrills', name: 'Jamaican Beef Patties', price: '5.99', price_real: 5.99 }),
    ];

    const stores = await discoverStores();
    expect(stores.map((s) => s.storeId)).toEqual(expect.arrayContaining(['fortinos', 'food-basics', 'no-frills']));

    const basket: BasketItem[] = [
      { id: 'grapes', name: 'green grapes', quantity: 1, unit: '' },
      { id: 'milk', name: 'lactose-free milk', quantity: 2, unit: 'L' },
      { id: 'patties', name: 'Jamaican patties', quantity: 1, unit: '', notes: 'sale only' },
      { id: 'bread', name: 'bread', quantity: 1, unit: '' },
    ];
    const offers: StoreOffers = {};
    for (const s of stores) {
      const names = basket.map((b) => b.name);
      const [flyer, shelfPrices] = await Promise.all([
        flippDealsAdapter.getPrices(names, s.storeId),
        storePricesAdapter.getPrices(names, s.storeId),
      ]);
      const byItem: Record<string, PriceResult[]> = {};
      for (const b of basket) {
        const list = [flyer.get(b.name), shelfPrices.get(b.name)].filter((p): p is PriceResult => !!p);
        if (list.length) byItem[b.id] = list;
      }
      offers[s.storeId] = byItem;
    }

    const plan = solvePlan(analyzeBasket(basket, offers, { now: NOW }), 2);
    expect(plan.fulfillment).toBe('complete');
    expect(plan.storeIds).toEqual(['food-basics', 'fortinos']);
    // grapes 3.49 + milk 5.99 + bread 2.19 at Food Basics, sale patties 4.49 at Fortinos
    expect(plan.totalCents).toBe(349 + 599 + 219 + 449);
    // Scraped shelf prices → an estimate, never a "verified cheapest" claim
    expect(plan.claim).toBe('estimate');
    const patties = plan.lines.find((l) => l.itemId === 'patties');
    expect(patties?.option?.storeId).toBe('fortinos');
  });
});
