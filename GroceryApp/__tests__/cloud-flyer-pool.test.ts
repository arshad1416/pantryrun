/**
 * Community pool prices (cloud-flyer) actually reach the basket:
 *  - lookups use plaintext names matched on the device (hashed names could
 *    never equal the pool's plaintext item names);
 *  - contributions and lookups agree on the pool store id
 *    ("<app store id>:<FSA>"), and neither runs without a region;
 *  - a pooled median prices one package, sized from the product name or
 *    of unknown content — never "each";
 *  - the matcher keeps look-alikes ("coconut milk") out.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { ScannedFlyerPrice } from '../src/pricing/flyer-types';

let mockSettings: Record<string, unknown> = {};
jest.mock('../src/config/settings', () => ({
  getSettings: jest.fn(() => mockSettings),
}));
jest.mock('../src/pricing/tokens', () => ({
  getContributionToken: jest.fn(async () => null),
  clearContributionTokenCache: jest.fn(),
}));

import { CloudFlyerAdapter, poolStoreId } from '../src/pricing/cloud-flyer';
import { adapterRequiresHash } from '../src/pricing/privacy';
import { submitContributions, resetContributionBuffer, getPendingBufferSize } from '../src/pricing/contribute';

const DAY = 24 * 60 * 60 * 1000;

function poolResponse(prices: unknown[]): Response {
  return { ok: true, json: async () => ({ storeId: 'x', prices }) } as unknown as Response;
}

function scanned(overrides: Partial<ScannedFlyerPrice> = {}): ScannedFlyerPrice {
  return {
    itemName: 'Neilson 2% Milk 4 L',
    storeId: 'no-frills',
    storeName: 'No Frills',
    price: 5.49,
    unit: 'L',
    quantity: 4,
    scannedAt: Date.now(),
    validTo: Date.now() + 7 * DAY,
    confidence: 0.92,
    saleInfo: null,
    ...overrides,
  };
}

describe('cloud-flyer pool lookups', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    mockSettings = { cloudFlyerEnabled: true, relayUrl: 'ws://relay.example.com', relayPort: 8080, flippFsa: 'm5v 2t6' };
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it('is matched on the device with plaintext names', () => {
    expect(adapterRequiresHash('cloud-flyer')).toBe(false);
  });

  it('pool store ids are "<store>:<FSA>", and null without a region', () => {
    expect(poolStoreId('no-frills', 'm5v 2t6')).toBe('no-frills:M5V');
    expect(poolStoreId('no-frills', '')).toBeNull();
    expect(poolStoreId('no-frills', undefined)).toBeNull();
  });

  it("asks for the store in the user's region and prices the matched package", async () => {
    fetchSpy.mockResolvedValue(poolResponse([
      { itemName: 'coconut milk 400 ml', flyerWeek: '2026-W41', median: 1.29, count: 4, stdev: 0.1, validTo: Date.now() + 10 * DAY },
      { itemName: 'neilson 2% milk 4 l', flyerWeek: '2026-W41', median: 5.49, count: 4, stdev: 0.1, validTo: Date.now() + 10 * DAY },
      { itemName: 'free run eggs', flyerWeek: '2026-W41', median: 4.99, count: 2, stdev: 0, validTo: Date.now() + 10 * DAY },
    ]));
    const adapter = new CloudFlyerAdapter();
    const results = await adapter.getCandidates(['milk', 'eggs'], 'no-frills');

    expect(String(fetchSpy.mock.calls[0][0])).toContain(`storeId=${encodeURIComponent('no-frills:M5V')}`);
    const milk = results.get('milk')!;
    expect(milk.map((r) => r.matchedName)).toEqual(['neilson 2% milk 4 l']);
    expect(milk[0]).toMatchObject({ price: 5.49, packageSize: 4, unit: 'L', pricingBasis: 'package' });
    // No size in the name: one package of unknown content, not "each".
    expect(results.get('eggs')![0]).toMatchObject({ price: 4.99, unit: 'pkg', pricingBasis: 'package' });
    expect(results.get('eggs')![0].packageSize).toBeUndefined();
  });

  it('fetches nothing without a region', async () => {
    mockSettings = { ...mockSettings, flippFsa: '' };
    const adapter = new CloudFlyerAdapter();
    expect((await adapter.getCandidates(['milk'], 'no-frills')).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('contributions use the same pool store id', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetContributionBuffer();
    mockSettings = { contributeEnabled: true, contributeStoreGranularity: 'region', relayUrl: 'ws://relay.example.com', relayPort: 8080, flippFsa: 'M5V' };
  });
  afterEach(() => {
    resetContributionBuffer();
    jest.useRealTimers();
  });

  it('files a scan under "<store>:<FSA>"', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    try {
      await submitContributions([scanned()]);
      expect(getPendingBufferSize()).toBe(1);
      await jest.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
      expect(body.storeId).toBe(poolStoreId('no-frills', 'M5V'));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('contributes nothing without a region', async () => {
    mockSettings = { ...mockSettings, flippFsa: undefined };
    await submitContributions([scanned()]);
    expect(getPendingBufferSize()).toBe(0);
  });
});
