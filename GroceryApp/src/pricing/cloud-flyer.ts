/**
 * Price Subsystem — CloudFlyerAdapter.
 *
 * Implements the PriceAdapter interface for community flyer prices sourced
 * from the pool server. Fetches aggregated prices from the relay server's
 * pool endpoints.
 *
 * Design:
 *  - Converts relay URL from ws:// to http:// for HTTP calls (same pattern as
 *    settings.ts testRelayConnection)
 *  - GETs /api/pool/prices?storeId=X for the store's whole pooled list and
 *    matches items on the device with the live feeds' relevance matcher
 *    (live-prices.ts findCandidateRows) — no item name leaves the device
 *  - Pool store ids are "<app store id>:<FSA>" (poolStoreId), the same id
 *    contribute.ts files contributions under; no FSA set, no lookup
 *  - A pooled median prices one package: its size comes from the product
 *    name when it has one, otherwise the offer is one package of unknown
 *    content (never "each")
 *  - Returns PriceResult with confidence derived from pool data freshness
 *
 * Critical rules:
 *  - Additive only — don't modify existing adapter logic
 *  - No contributor/IP/fine-timestamp stored on this adapter
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult, PriceSourceTier, ConfidenceLevel } from './types';
import { getSettings } from '../config/settings';
import { getRelayHttpBaseUrl } from './relay-client';
import { findCandidateRows, normalizeFsa, packageFromName, UNKNOWN_PACKAGE_UNIT } from './live-prices';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PoolPriceEntry {
  itemName: string;
  flyerWeek: string;
  median: number | null;
  count: number;
  stdev: number | null;
  validTo: number;
}

interface PoolApiResponse {
  storeId: string;
  prices: PoolPriceEntry[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The pool's report window: a flyer week runs about two weeks before validTo. */
const FLYER_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The pool store id for an app store in a region: "<storeId>:<FSA>" (e.g.
 * "no-frills:M5V"). Contributions are filed under it and lookups ask for it,
 * so both sides agree. null without a usable FSA — a region-less id would
 * mix every region's prices together.
 */
export function poolStoreId(storeId: string, fsa: string | undefined | null): string | null {
  const region = normalizeFsa(fsa);
  const store = storeId.trim();
  return region && store ? `${store}:${region}` : null;
}

/**
 * Determine confidence level based on pool data freshness and report count.
 */
function getConfidenceLevel(
  count: number,
  validTo: number,
): ConfidenceLevel {
  const now = Date.now();
  const remainingMs = validTo - now;
  const remainingDays = remainingMs / (24 * 60 * 60 * 1000);

  if (remainingDays <= 0) return 'stale';
  if (count >= 5 && remainingDays > 7) return 'real_time';
  if (count >= 3 && remainingDays > 3) return 'recent';
  if (count >= 1 && remainingDays > 1) return 'estimated';
  return 'stale';
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CloudFlyerAdapter implements PriceAdapter {
  id = 'cloud-flyer';
  name = 'Community Flyer Prices';
  tier: PriceSourceTier = 'crowd';

  isAvailable(): boolean {
    const settings = getSettings();
    return !!(settings.cloudFlyerEnabled && settings.relayUrl);
  }

  /**
   * Fetch pooled prices for a store (in the user's region) from the relay.
   */
  private async fetchPoolPrices(
    storeId: string,
  ): Promise<PoolPriceEntry[]> {
    const poolId = poolStoreId(storeId, getSettings().flippFsa);
    if (!poolId) return [];
    const baseUrl = getRelayHttpBaseUrl();
    if (!baseUrl) return [];

    try {
      const url = `${baseUrl}/api/pool/prices?storeId=${encodeURIComponent(poolId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return [];

      const data: PoolApiResponse = await response.json();
      return Array.isArray(data.prices) ? data.prices : [];
    } catch {
      return [];
    }
  }

  private toPriceResult(match: PoolPriceEntry, storeId: string): PriceResult {
    const price = match.median as number;
    const pkg = packageFromName(match.itemName);
    return {
      price,
      unitPrice: price,
      unit: pkg?.unit ?? UNKNOWN_PACKAGE_UNIT,
      ...(pkg ? { packageSize: pkg.packageSize } : {}),
      pricingBasis: 'package',
      saleInfo: null,
      source: {
        adapterId: this.id,
        tier: this.tier,
        storeId,
        storeName: storeId, // pool doesn't store store names separately
      },
      timestamp: match.validTo - FLYER_SPAN_MS, // estimate: ~2 weeks before validTo
      confidence: getConfidenceLevel(match.count, match.validTo),
      matchedName: match.itemName,
      validTo: match.validTo,
    };
  }

  /** Ranked pooled matches per item (best first, newest flyer week on a tie). */
  async getCandidates(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult[]>> {
    const results = new Map<string, PriceResult[]>();
    const now = Date.now();
    const prices = (await this.fetchPoolPrices(storeId)).filter(
      (p) => typeof p.itemName === 'string' && typeof p.median === 'number' && p.median > 0 && p.validTo > now,
    );
    if (prices.length === 0) return results;
    for (const item of items) {
      const rows = findCandidateRows(item, prices, (p) => p.itemName, (p) => p.median, (p) => p.validTo);
      if (rows.length > 0) results.set(item, rows.map((p) => this.toPriceResult(p, storeId)));
    }
    return results;
  }

  async getPrice(
    itemName: string,
    storeId: string,
  ): Promise<PriceResult | null> {
    return (await this.getCandidates([itemName], storeId)).get(itemName)?.[0] ?? null;
  }

  async getPrices(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    for (const [item, list] of await this.getCandidates(items, storeId)) results.set(item, list[0]);
    return results;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const cloudFlyerAdapter = new CloudFlyerAdapter();
