/**
 * Price matching — which scraped products may stand in for a list item.
 *
 *  1. Relevance: a product that merely contains the item's words is not the
 *     item ("milk" ≠ coconut milk, "eggs" ≠ Cadbury Mini Eggs, "apples" ≠
 *     apple juice). Category-changing words reject; extra words rank lower.
 *  2. Candidates: adapters return several ranked candidates and the basket's
 *     eligibility + purchase math picks among them; the registry gathers
 *     candidates from every adapter, not just the first that answers.
 *  3. Freshness: the newest scrape of a product wins over an older, cheaper
 *     one; a truncated relay answer is noticed.
 *
 * Run: npx jest __tests__/price-matching.test.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

let mockSettings: Record<string, unknown> = {};
jest.mock('../src/config/settings', () => ({
  getSettings: () => mockSettings,
  updateSettings: async (patch: Record<string, unknown>) => { mockSettings = { ...mockSettings, ...patch }; },
}));
jest.mock('../src/identity/enroll', () => ({ getRelayToken: async () => 'relay-token-abc' }));

import {
  _resetLivePrices,
  findBestRow,
  findCandidateRows,
  getLivePriceStatus,
  loadShelfPrices,
  type FlyerDealRow,
  type ShelfPriceRow,
} from '../src/pricing/live-prices';
import { flippDealsAdapter } from '../src/pricing/flipp-deals-adapter';
import { storePricesAdapter } from '../src/pricing/store-prices-adapter';
import { priceRegistry } from '../src/pricing/registry';
import { analyzeBasket, solvePlan, type StoreOffers } from '../src/pricing/basket';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

let dealRows: FlyerDealRow[] = [];
let shelfRows: ShelfPriceRow[] = [];
let truncated = false;
const realFetch = global.fetch;

beforeEach(() => {
  _resetLivePrices();
  mockSettings = {
    relayUrl: 'wss://relay.example.com', relayPort: 8080, flippFsa: 'L0R',
    pricingOptedIn: true,
    // Only the live feeds: keep local seed/demo adapters out of these assertions.
    adapterEnabled: { crowdsourced: false, 'flyer-scan': false, 'cloud-flyer': false, instacart: false, scraping: false },
  };
  dealRows = [];
  shelfRows = [];
  truncated = false;
  global.fetch = (async (url: string) => {
    const kind = url.includes('/api/prices/deals') ? 'deals' : 'shelf';
    return {
      ok: true,
      status: 200,
      json: async () => ({ kind, fsa: 'L0R', fetchedAt: new Date(NOW).toISOString(), truncated, rows: kind === 'deals' ? dealRows : shelfRows }),
    };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

function deal(name: string, price: number, over: Partial<FlyerDealRow> = {}): FlyerDealRow {
  return { merchant: 'No Frills', name, price: String(price), price_real: price, image_url: null, valid_from: null, valid_to: '2099-01-01', ...over };
}
function shelf(name: string, price: number, over: Partial<ShelfPriceRow> = {}): ShelfPriceRow {
  return {
    store_id: 'nofrills', store_name: 'No Frills', name, price: String(price), price_real: price,
    unit: 'each', unit_price_real: null, is_on_sale: 0, sale_price: null, was_price: null,
    scraped_at: sqliteUtc(NOW - HOUR), ...over,
  };
}

const nameOf = (r: { name: string }) => r.name;
const priceOf = (r: { price_real: number | null }) => r.price_real;

describe('1. relevance', () => {
  it.each([
    ['milk', ['Coconut Milk 400 mL', 'Milk Chocolate Bar 100 g', 'Neilson 2% Milk 4 L'], 'Neilson 2% Milk 4 L'],
    ['eggs', ['Cadbury Mini Eggs 300 g', 'Burnbrae Large Eggs 12 Pack'], 'Burnbrae Large Eggs 12 Pack'],
    ['apples', ['Apple Juice 1.89 L', 'Gala Apples 3 lb'], 'Gala Apples 3 lb'],
    ['potatoes', ['Lay’s Potato Chips 235 g', 'Russet Potatoes 10 lb'], 'Russet Potatoes 10 lb'],
    ['tomatoes', ['Hunt’s Tomato Sauce 680 mL', 'Roma Tomatoes'], 'Roma Tomatoes'],
  ])('"%s" picks the real product over cheaper look-alikes', (item, names, expected) => {
    // Look-alikes are cheaper, so "cheapest on a tie" used to pick them.
    const rows = names.map((n, i) => deal(n, 1 + i));
    expect(findBestRow(item, rows, nameOf, priceOf)?.name).toBe(expected);
  });

  it('a category-changer the item asks for is fine', () => {
    const rows = [deal('Coconut Milk 400 mL', 1.99), deal('Neilson 2% Milk 4 L', 5.49)];
    expect(findBestRow('coconut milk', rows, nameOf, priceOf)?.name).toBe('Coconut Milk 400 mL');
    expect(findBestRow('apple juice', [deal('Apple Juice 1.89 L', 2.5), deal('Gala Apples 3 lb', 3)], nameOf, priceOf)?.name).toBe('Apple Juice 1.89 L');
  });

  it('only look-alikes → no match at all', () => {
    expect(findBestRow('eggs', [deal('Cadbury Mini Eggs 300 g', 2.99)], nameOf, priceOf)).toBeNull();
  });

  it('fewer extra words rank first', () => {
    const rows = [deal('Sealtest Partly Skimmed Fine-Filtered Milk 4 L', 1), deal('Sealtest Milk 4 L', 5)];
    expect(findCandidateRows('milk', rows, nameOf, priceOf).map((r) => r.name)).toEqual([
      'Sealtest Milk 4 L',
      'Sealtest Partly Skimmed Fine-Filtered Milk 4 L',
    ]);
  });
});

describe('2. several candidates, picked by the basket', () => {
  it('adapters return ranked candidates; the basket costs the cheapest that fits', async () => {
    dealRows = [deal('Neilson 2% Milk 4 L', 5.49), deal('Lactantia Milk 1 L', 2.49), deal('Coconut Milk 400 mL', 0.99)];
    const cands = await flippDealsAdapter.getCandidates(['milk'], 'no-frills');
    const names = cands.get('milk')!.map((c) => c.matchedName);
    expect(names).toEqual(expect.arrayContaining(['Neilson 2% Milk 4 L', 'Lactantia Milk 1 L']));
    expect(names).not.toContain('Coconut Milk 400 mL');

    // 4 L of milk: one 4 L jug ($5.49) beats four 1 L cartons ($9.96).
    const offers: StoreOffers = { 'no-frills': { m: cands.get('milk') } };
    const plan = solvePlan(analyzeBasket([{ id: 'm', name: 'milk', quantity: 4, unit: 'L' }], offers, { now: NOW }), 1);
    expect(plan.totalCents).toBe(549);
  });

  it('the registry gathers candidates from every adapter, not just the first', async () => {
    dealRows = [deal('Neilson 2% Milk 4 L', 6.99)];
    shelfRows = [shelf('Neilson 2% Milk 4 L', 5.29)];
    const all = await priceRegistry.getAllCandidates(['milk'], 'no-frills');
    const adapters = all.get('milk')!.map((c) => c.source.adapterId);
    expect(adapters).toEqual(['flipp-deals', 'store-prices']);
    // The cheaper shelf price is costed even though the flyer adapter answered first.
    const plan = solvePlan(analyzeBasket([{ id: 'm', name: 'milk', quantity: 1, unit: '' }], { 'no-frills': { m: all.get('milk') } }, { now: NOW }), 1);
    expect(plan.totalCents).toBe(529);
    // getPrice still answers with the highest-priority candidate.
    expect((await priceRegistry.getPrice('milk', 'no-frills'))?.source.adapterId).toBe('flipp-deals');
  });
});

describe('3. freshness', () => {
  it('the newest scrape of a product wins over an older, cheaper one', async () => {
    shelfRows = [
      shelf('Neilson 2% Milk 4 L', 4.49, { scraped_at: sqliteUtc(NOW - 5 * 24 * HOUR), name_clean: 'neilson 2 milk 4 l' }),
      shelf('Neilson 2% Milk 4 L', 5.99, { scraped_at: sqliteUtc(NOW - HOUR), name_clean: 'neilson 2 milk 4 l' }),
    ];
    const pr = await storePricesAdapter.getPrice('milk', 'no-frills');
    expect(pr?.price).toBe(5.99);
    const cands = await storePricesAdapter.getCandidates(['milk'], 'no-frills');
    expect(cands.get('milk')!.map((c) => c.price)).toEqual([5.99]);
  });

  it('a truncated relay answer is noticed', async () => {
    truncated = true;
    shelfRows = [shelf('Milk 4 L', 5)];
    const snap = await loadShelfPrices('L0R');
    expect(snap?.truncated).toBe(true);
    expect(getLivePriceStatus()).toMatchObject({ state: 'ok', truncated: true });
    expect(getLivePriceStatus().detail).toMatch(/partial|some/i);
  });
});
