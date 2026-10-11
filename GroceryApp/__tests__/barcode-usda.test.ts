/**
 * USDA FoodData Central is a full-text search: a barcode query returns
 * whatever foods mention the digits, so the first hit is not the scanned
 * product. Only a food whose gtinUpc is the scanned code may name it — and
 * the consent prompt must name USDA whenever the build can send to it.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../src/config/settings', () => ({
  getSettings: jest.fn(() => ({ barcodeScanningEnabled: true })),
  setBarcodeScanningEnabled: jest.fn(async () => undefined),
}));
jest.mock('../src/services/tursoClient', () => ({
  isTursoReady: () => false,
  getTurso: () => { throw new Error('no turso'); },
}));
jest.mock('../src/services/aiCleanup', () => ({ cleanProductName: jest.fn() }));
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));

const BARCODE = '012345678905';
const realFetch = global.fetch;
const ORIGINAL_KEY = process.env.EXPO_PUBLIC_USDA_API_KEY;

function respond(usdaFoods: unknown[]): void {
  global.fetch = (async (url: string) => {
    if (url.includes('openfoodfacts')) return { ok: true, status: 200, json: async () => ({ status: 0 }) };
    return { ok: true, status: 200, json: async () => ({ foods: usdaFoods }) };
  }) as unknown as typeof fetch;
}

function loadLookup(): typeof import('../src/services/productLookup') {
  let mod!: typeof import('../src/services/productLookup');
  jest.isolateModules(() => {
    mod = require('../src/services/productLookup');
  });
  return mod;
}

describe('USDA barcode lookup', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_USDA_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (ORIGINAL_KEY === undefined) delete process.env.EXPO_PUBLIC_USDA_API_KEY;
    else process.env.EXPO_PUBLIC_USDA_API_KEY = ORIGINAL_KEY;
  });

  it('names the product only from the food whose gtinUpc is the scanned code', async () => {
    respond([
      { description: 'SOMETHING ELSE THAT MENTIONS THE DIGITS', gtinUpc: '812345678905' },
      { description: 'THE SCANNED CEREAL', gtinUpc: '00012345678905', brandName: 'ACME' },
    ]);
    const result = await loadLookup().lookupProduct(BARCODE);
    expect(result).toMatchObject({ status: 'found', product: { productName: 'THE SCANNED CEREAL', source: 'usda' } });
  });

  it('a search with no exact gtinUpc match is not found, not the first hit', async () => {
    respond([
      { description: 'UNRELATED FOOD', gtinUpc: '812345678905' },
      { description: 'NO BARCODE AT ALL' },
    ]);
    const result = await loadLookup().lookupProduct(BARCODE);
    expect(result).toEqual({ status: 'not_found', barcode: BARCODE });
  });

  it('compares codes ignoring leading zeros (UPC-A vs GTIN-14)', () => {
    const { normalizeGtin } = loadLookup();
    expect(normalizeGtin('00012345678905')).toBe(normalizeGtin('012345678905'));
    expect(normalizeGtin('812345678905')).not.toBe(normalizeGtin('012345678905'));
  });
});

describe('barcode consent text', () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.EXPO_PUBLIC_USDA_API_KEY;
    else process.env.EXPO_PUBLIC_USDA_API_KEY = ORIGINAL_KEY;
  });

  it('names USDA when the build can send barcodes to it', () => {
    process.env.EXPO_PUBLIC_USDA_API_KEY = 'test-key';
    const { barcodeLookupDisclosure } = require('../src/services/barcodeConsent');
    expect(barcodeLookupDisclosure()).toMatch(/Open Food Facts/);
    expect(barcodeLookupDisclosure()).toMatch(/USDA/);
  });

  it('names only Open Food Facts without a USDA key', () => {
    delete process.env.EXPO_PUBLIC_USDA_API_KEY;
    const { barcodeLookupDisclosure } = require('../src/services/barcodeConsent');
    expect(barcodeLookupDisclosure()).toMatch(/Open Food Facts/);
    expect(barcodeLookupDisclosure()).not.toMatch(/USDA/);
  });
});
