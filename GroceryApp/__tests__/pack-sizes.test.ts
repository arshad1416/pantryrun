/**
 * Pack sizes — what one scraped offer actually contains.
 *
 *  1. Counts ("12 Pack", "12 ct", "dozen") and multipacks ("6 x 355 mL",
 *     "4x100g") become a package size, so "Eggs ×12 pcs" buys one carton.
 *  2. An offer with no recognisable size is one package of unknown
 *     content — never a per-each price.
 *  3. Multi-buy breakdowns never show an empty "0 × …" group.
 *
 * Run: npx jest __tests__/pack-sizes.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  flyerDealToPriceResult,
  packageFromName,
  shelfPriceToPriceResult,
  type FlyerDealRow,
  type ShelfPriceRow,
  type Snapshot,
} from '../src/pricing/live-prices';
import { lineCost } from '../src/pricing/basket';
import { parseRequirement, purchaseFor } from '../src/pricing/quantity';
import type { PriceResult } from '../src/pricing/types';

const NOW = Date.now();
const snap = <T,>(): Snapshot<T> => ({ fsa: 'L0R', rows: [], fetchedAt: NOW, loadedAt: NOW });
const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function deal(over: Partial<FlyerDealRow>): FlyerDealRow {
  return { merchant: 'No Frills', name: 'Item', price: '1.00', price_real: 1, image_url: null, valid_from: null, valid_to: '2099-01-01', ...over };
}
function shelf(over: Partial<ShelfPriceRow>): ShelfPriceRow {
  return {
    store_id: 'nofrills', store_name: 'No Frills', name: 'Item', price: '1.00', price_real: 1,
    unit: 'each', unit_price_real: null, is_on_sale: 0, sale_price: null, was_price: null,
    scraped_at: sqliteUtc(NOW - 60 * 60 * 1000), ...over,
  };
}

describe('1. counts and multipacks in product names', () => {
  it.each([
    ['Burnbrae Large Eggs 12 Pack', { packageSize: 12, unit: 'each' }],
    ['Large Eggs 12 pk', { packageSize: 12, unit: 'each' }],
    ['Freybe Hot Dogs 8-pk', { packageSize: 8, unit: 'each' }],
    ['Kirkland Batteries 12 ct', { packageSize: 12, unit: 'each' }],
    ['Bagels 6 count', { packageSize: 6, unit: 'each' }],
    ['Grade A Large Eggs, Dozen', { packageSize: 12, unit: 'each' }],
    ['Eggs Half Dozen', { packageSize: 6, unit: 'each' }],
    ['Eggs 2 Dozen', { packageSize: 24, unit: 'each' }],
    ['Coca-Cola 6 x 355 mL', { packageSize: 2130, unit: 'ml' }],
    ['Coca-Cola 12 x 355 mL', { packageSize: 4260, unit: 'ml' }],
    ['Activia Yogurt 4x100g', { packageSize: 400, unit: 'g' }],
    ['Water 24 × 0.5 L', { packageSize: 12, unit: 'L' }],
    ['Pepsi 12 pk 355 mL', { packageSize: 4260, unit: 'ml' }],
    ['Neilson 2% Milk 4 L', { packageSize: 4, unit: 'L' }],
  ])('%s', (name, expected) => {
    expect(packageFromName(name)).toEqual(expected);
  });

  it('a bare "2 x 3" or no size is unknown content', () => {
    expect(packageFromName('Jamaican Beef Patties')).toBeNull();
    expect(packageFromName('Combo 2 x 3')).toBeNull();
  });

  it('"Eggs ×12 pcs" at a $3.99 12-pack costs $3.99, not $47.88', () => {
    const pr = flyerDealToPriceResult(deal({ name: 'Burnbrae Large Eggs 12 Pack', price: '3.99', price_real: 3.99 }), snap())!;
    expect(lineCost({ quantity: 12, unit: 'pcs' }, pr).cost).toBe(3.99);
    expect(lineCost({ quantity: 18, unit: 'pcs' }, pr).cost).toBe(7.98); // two cartons
    const shelfPr = shelfPriceToPriceResult(shelf({ name: 'Large Eggs 12 ct', price: '4.49', price_real: 4.49 }), snap(), NOW)!;
    expect(lineCost({ quantity: 1, unit: 'dozen' }, shelfPr).cost).toBe(4.49);
  });

  it('"Coke ×2 L" at a 6 × 355 mL pack buys one pack', () => {
    const pr = flyerDealToPriceResult(deal({ name: 'Coca-Cola 6 x 355 mL', price: '4.99', price_real: 4.99 }), snap())!;
    expect(lineCost({ quantity: 2, unit: 'L' }, pr).cost).toBe(4.99);
  });
});

describe('2. unknown contents are package-only, never per each', () => {
  it('flyer offer with no size', () => {
    const pr = flyerDealToPriceResult(deal({ name: 'Cadbury Mini Eggs', price: '3.99', price_real: 3.99 }), snap())!;
    expect(pr.unit).not.toBe('each');
    expect(pr.pricingBasis).toBe('package');
    // 12 pieces of "something" can't be priced from one package of unknown size…
    expect(lineCost({ quantity: 12, unit: 'pcs' }, pr)).toMatchObject({ cost: null, reason: 'pack_size_unknown' });
    // …but "1 of these" (no unit) is one package.
    expect(lineCost({ quantity: 1, unit: '' }, pr).cost).toBe(3.99);
  });

  it('shelf offer with no size (scraper default unit "each")', () => {
    const pr = shelfPriceToPriceResult(shelf({ name: 'Wonder Bread', price: '2.99', price_real: 2.99, unit: 'each' }), snap(), NOW)!;
    expect(pr.unit).not.toBe('each');
    expect(lineCost({ quantity: 3, unit: 'pcs' }, pr)).toMatchObject({ cost: null, reason: 'pack_size_unknown' });
    expect(lineCost({ quantity: 2, unit: '' }, pr).cost).toBe(5.98);
  });
});

describe('3. multi-buy breakdown', () => {
  const offer: PriceResult = {
    price: 1 / 3, unitPrice: 1 / 3, unit: 'pkg', pricingBasis: 'package', saleInfo: null,
    source: { adapterId: 'flipp-deals', tier: 'flyer', storeId: 'no-frills', storeName: 'No Frills' },
    timestamp: NOW, confidence: 'recent', multiBuy: { groupSize: 3, groupPrice: 1, requiresFullGroup: false },
  };
  const req = (n: number) => {
    const r = parseRequirement(n, '');
    if (!r.ok) throw new Error('bad requirement');
    return r.requirement;
  };

  it('omits a zero group', () => {
    const p = purchaseFor(req(1), offer);
    expect(p.ok && p.purchase.breakdown).toBe('1 × $0.33');
  });

  it('keeps both groups when both are used', () => {
    const p = purchaseFor(req(4), offer);
    expect(p.ok && p.purchase.breakdown).toBe('1 × 3 for $1.00 + 1 × $0.33');
  });
});
