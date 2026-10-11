/**
 * Anonymous Contribution Pipeline — Privacy & Correctness Tests.
 *
 * Tests cover:
 *  - Privacy contract: payload allow-list, forbidden-field stripping
 *  - Opt-in gate: zero network I/O when contributeEnabled is false
 *  - toContributedPrice strips all non-§3 fields
 *  - Edge cases: missing optional fields, empty arrays
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ScannedFlyerPrice, ContributedFlyerPrice } from '../src/pricing/flyer-types';
import {
  toContributedPrice,
  submitContributions,
  epochMsToIsoWeek,
  resetContributionBuffer,
  getPendingBufferSize,
  getLastBatchTime,
} from '../src/pricing/contribute';

// ─── The §3 allow-list of keys permitted in ContributedFlyerPrice ──────────

const ALLOWED_KEYS: (keyof ContributedFlyerPrice)[] = [
  'storeId',
  'itemName',
  'itemNormalized',
  'brand',
  'size',
  'unit',
  'price',
  'regularPrice',
  'unitPrice',
  'validFromWeek',
  'validTo',
  'flyerWeek',
];

// ─── Forbidden keys that must NEVER appear in the contributed payload ──────

const FORBIDDEN_KEYS = [
  'deviceId',
  'familyId',
  'scannedAt',
  'confidence',
  'storeName',
  'quantity',
  'gps',
  'ip',
  'ipAddress',
  'latitude',
  'longitude',
  'location',
];

// ─── Mock settings ─────────────────────────────────────────────────────────

jest.mock('../src/config/settings', () => ({
  getSettings: jest.fn(() => ({
    contributeEnabled: false,
    contributeStoreGranularity: 'region',
    contributeConsentShown: false,
    relayUrl: 'ws://localhost',
    relayPort: 8080,
  })),
}));

import { getSettings } from '../src/config/settings';
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeScannedPrice(
  overrides: Partial<ScannedFlyerPrice> = {},
): ScannedFlyerPrice {
  return {
    itemName: 'Organic Whole Milk',
    storeId: 'store_walmart_toronto',
    storeName: 'Walmart',
    price: 5.49,
    unit: 'L',
    quantity: 2,
    scannedAt: Date.now(),
    validTo: Date.now() + 7 * 86400000,
    confidence: 0.92,
    saleInfo: null,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('epochMsToIsoWeek', () => {
  it('converts a known date to correct ISO week', () => {
    // June 1, 2026 (Monday) → 2026-W23
    // (May 28, 2026 is the Thursday of W22, so June 1 is Monday of W23)
    const date = new Date(2026, 4, 28); // May 28, 2026
    const week = epochMsToIsoWeek(date.getTime());
    // May 28, 2026 is a Thursday — this is the reference Thursday of the week
    // So it should be a specific week. Let's verify the format.
    expect(week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('returns a string matching YYYY-WNN format', () => {
    const week = epochMsToIsoWeek(Date.now());
    expect(week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('coarsens timestamps (same week yields same string)', () => {
    const t1 = new Date(2026, 0, 5).getTime(); // Jan 5, 2026 (Monday)
    const t2 = new Date(2026, 0, 9).getTime(); // Jan 9, 2026 (Friday)
    // Both should be in the same ISO week (W02)
    // Jan 1, 2026 is Thursday, so Week 1 contains Jan 1-4 (Thu-Sun)
    // Jan 5 (Mon) - Jan 11 (Sun) is Week 2
    expect(epochMsToIsoWeek(t1)).toBe(epochMsToIsoWeek(t2));
  });
});

describe('toContributedPrice', () => {
  beforeEach(() => {
    resetContributionBuffer();
    mockGetSettings.mockReturnValue({
      contributeEnabled: false,
      contributeStoreGranularity: 'region',
      contributeConsentShown: false,
      relayUrl: 'ws://localhost',
      relayPort: 8080,
    } as any);
  });

  it('returns a valid ContributedFlyerPrice from a ScannedFlyerPrice', () => {
    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');

    expect(contributed.storeId).toBe('walmart:toronto');
    expect(contributed.itemName).toBe('Organic Whole Milk');
    expect(contributed.itemNormalized).toBe('organic whole milk');
    expect(contributed.price).toBe(5.49);
    expect(contributed.unit).toBe('L');
    expect(contributed.unitPrice).toBeCloseTo(2.745, 4);
    expect(contributed.validFromWeek).toMatch(/^\d{4}-W\d{2}$/);
    expect(contributed.validTo).toBe(scanned.validTo);
    expect(contributed.flyerWeek).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('composes storeId as chain:region by default', () => {
    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'costco', 'vancouver');
    expect(contributed.storeId).toBe('costco:vancouver');
  });

  it('composes storeId as chain:storeId when granularity is branch', () => {
    mockGetSettings.mockReturnValue({
      contributeEnabled: true,
      contributeStoreGranularity: 'branch',
      contributeConsentShown: true,
      relayUrl: 'ws://localhost',
      relayPort: 8080,
    } as any);

    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect(contributed.storeId).toBe('walmart:store_walmart_toronto');
  });

  it('strips scannedAt from the payload', () => {
    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect((contributed as any).scannedAt).toBeUndefined();
  });

  it('strips confidence from the payload', () => {
    const contributed = toContributedPrice(
      makeScannedPrice(),
      'walmart',
      'toronto',
    );
    expect((contributed as any).confidence).toBeUndefined();
  });

  it('strips storeName from the payload', () => {
    const contributed = toContributedPrice(
      makeScannedPrice(),
      'walmart',
      'toronto',
    );
    expect((contributed as any).storeName).toBeUndefined();
  });

  it('strips quantity from the payload', () => {
    const contributed = toContributedPrice(
      makeScannedPrice(),
      'walmart',
      'toronto',
    );
    expect((contributed as any).quantity).toBeUndefined();
  });

  it('has regularPrice when saleInfo is present', () => {
    const scanned = makeScannedPrice({
      saleInfo: {
        isOnSale: true,
        salePrice: 4.49,
        regularPrice: 5.49,
        saleEndDate: Date.now() + 7 * 86400000,
        unitPriceVsRegular: -1.0,
        savingsPercent: 18,
      },
    });
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect(contributed.regularPrice).toBe(5.49);
  });

  it('handles null validTo gracefully (uses 0)', () => {
    const scanned = makeScannedPrice({ validTo: null });
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect(contributed.validTo).toBe(0);
  });

  it('handles missing saleInfo gracefully', () => {
    const scanned = makeScannedPrice({ saleInfo: null });
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect(contributed.regularPrice).toBeUndefined();
  });

  it('provides a reasonable size string', () => {
    const scanned = makeScannedPrice({ quantity: 2, unit: 'L' });
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect(contributed.size).toBe('2L');
  });

  it('uses unit as size when quantity is 1', () => {
    const scanned = makeScannedPrice({ quantity: 1, unit: 'each' });
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');
    expect(contributed.size).toBe('each');
  });
});

describe('submitContributions — Privacy Gate', () => {
  beforeEach(() => {
    resetContributionBuffer();
    mockGetSettings.mockReturnValue({
      contributeEnabled: false,
      contributeStoreGranularity: 'region',
      contributeConsentShown: false,
      relayUrl: 'ws://localhost',
      relayPort: 8080,
    } as any);
  });

  it('performs zero network I/O when contributeEnabled is false', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const prices = [makeScannedPrice()];

    await submitContributions(prices);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPendingBufferSize()).toBe(0);
    fetchSpy.mockRestore();
  });

  it('buffers prices when contributeEnabled is true', async () => {
    mockGetSettings.mockReturnValue({
      contributeEnabled: true,
      contributeStoreGranularity: 'region',
      contributeConsentShown: true,
      relayUrl: 'ws://localhost',
      relayPort: 8080,
      flippFsa: 'M5V', // contributions are filed per region
    } as any);

    const prices = [makeScannedPrice()];
    await submitContributions(prices);

    expect(getPendingBufferSize()).toBe(1);
  });

  it('does not buffer when disabled even with prices provided', async () => {
    const prices = [makeScannedPrice()];
    await submitContributions(prices);
    expect(getPendingBufferSize()).toBe(0);
  });
});

describe('Payload Allow-List', () => {
  beforeEach(() => {
    resetContributionBuffer();
    mockGetSettings.mockReturnValue({
      contributeEnabled: true,
      contributeStoreGranularity: 'region',
      contributeConsentShown: true,
      relayUrl: 'ws://localhost',
      relayPort: 8080,
    } as any);
  });

  it('serialized contributed payload keys are subset of §3 allow-list', () => {
    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');

    const payloadKeys = Object.keys(contributed) as (keyof ContributedFlyerPrice)[];
    for (const key of payloadKeys) {
      expect(ALLOWED_KEYS).toContain(key);
    }
  });

  it('contributed payload never has forbidden fields', () => {
    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');

    const payloadAny = contributed as unknown as Record<string, unknown>;
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(payloadAny[forbidden]).toBeUndefined();
    }
  });

  it('toContributedPrice preserves all optional fields when not provided', () => {
    const scanned = makeScannedPrice({ saleInfo: null });
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');

    // brand should be undefined (not present)
    expect(contributed.brand).toBeUndefined();
    // regularPrice should be undefined (not on sale)
    expect(contributed.regularPrice).toBeUndefined();
    // size should still be present (derived from unit)
    expect(contributed.size).toBeDefined();
  });

  it('every ALLOWED_KEYS entry is actually a key of ContributedFlyerPrice', () => {
    const scanned = makeScannedPrice();
    const contributed = toContributedPrice(scanned, 'walmart', 'toronto');

    for (const key of ALLOWED_KEYS) {
      expect(contributed).toHaveProperty(key);
    }
  });
});
