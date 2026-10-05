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
 *  - GETs /api/pool/prices?storeId=X, filters results for matching items
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

function normalizeItemName(name: string): string {
  return name.toLowerCase().trim();
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
   * Fetch pooled prices for a store from the relay server.
   */
  private async fetchPoolPrices(
    storeId: string,
  ): Promise<PoolPriceEntry[]> {
    const baseUrl = getRelayHttpBaseUrl();
    if (!baseUrl) return [];

    try {
      const url = `${baseUrl}/api/pool/prices?storeId=${encodeURIComponent(storeId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return [];

      const data: PoolApiResponse = await response.json();
      return data.prices || [];
    } catch {
      return [];
    }
  }

  async getPrice(
    itemName: string,
    storeId: string,
  ): Promise<PriceResult | null> {
    const prices = await this.fetchPoolPrices(storeId);
    const normalized = normalizeItemName(itemName);
    const match = prices.find((p) => p.itemName === normalized);

    if (!match || match.median === null) return null;

    return {
      price: match.median,
      unitPrice: match.median,
      unit: 'each',
      saleInfo: null,
      source: {
        adapterId: this.id,
        tier: this.tier,
        storeId,
        storeName: storeId, // pool doesn't store store names separately
      },
      timestamp: match.validTo - 14 * 24 * 60 * 60 * 1000, // estimate: ~2 weeks before validTo
      confidence: getConfidenceLevel(match.count, match.validTo),
    };
  }

  async getPrices(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    const prices = await this.fetchPoolPrices(storeId);

    for (const item of items) {
      const normalized = normalizeItemName(item);
      const match = prices.find((p) => p.itemName === normalized);

      if (match && match.median !== null) {
        results.set(item, {
          price: match.median,
          unitPrice: match.median,
          unit: 'each',
          saleInfo: null,
          source: {
            adapterId: this.id,
            tier: this.tier,
            storeId,
            storeName: storeId,
          },
          timestamp: match.validTo - 14 * 24 * 60 * 60 * 1000,
          confidence: getConfidenceLevel(match.count, match.validTo),
        });
      }
    }

    return results;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const cloudFlyerAdapter = new CloudFlyerAdapter();
