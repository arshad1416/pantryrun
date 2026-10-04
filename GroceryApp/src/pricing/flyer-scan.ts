/**
 * Price Subsystem — Flyer Scan Adapter.
 *
 * Implements the PriceAdapter interface for flyer-scanned prices.
 * Follows the same pattern as CrowdsourcedAdapter but with
 * flyer-specific storage, confidence scoring, and sale detection.
 *
 * Design:
 *  - Internal Map<string, ScannedFlyerPrice[]> keyed by normalized item name
 *  - submitScannedPrices() to persist scanned flyer data
 *  - getPrice/getPrices returns the newest valid price for item at store
 *  - Confidence: 'stale' when validTo has passed
 *  - Uses normalizeUnitPrice() for unit price computation
 *
 * Critical rules:
 *  - Additive only — don't modify existing adapter logic
 *  - EXIF stripped before any processing (handled by pipeline, not adapter)
 *  - Image discarded after extraction (handled by pipeline, not adapter)
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult, PriceSourceTier, ConfidenceLevel } from './types';
import type { ScannedFlyerPrice } from './flyer-types';
import { normalizeUnitPrice } from './normalizer';

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeItemName(name: string): string {
  return name.toLowerCase().trim();
}

function getConfidenceLevel(
  modelConfidence: number,
): ConfidenceLevel {
  if (modelConfidence >= 0.9) return 'real_time';
  if (modelConfidence >= 0.75) return 'recent';
  if (modelConfidence >= 0.6) return 'estimated';
  return 'estimated';
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class FlyerScanAdapter implements PriceAdapter {
  id = 'flyer-scan';
  name = 'Flyer Scan';
  tier: PriceSourceTier = 'flyer';

  /**
   * Internal price store: normalizedItemName → ScannedFlyerPrice[]
   * We keep all scanned prices so we can return the newest valid one.
   */
  private prices: Map<string, ScannedFlyerPrice[]> = new Map();

  isAvailable(): boolean {
    return true; // always available locally
  }

  /**
   * Submit scanned flyer prices to the internal store.
   * Multiple prices for the same item are kept for price history.
   *
   * @param records - Array of ScannedFlyerPrice entries from the pipeline
   */
  async submitScannedPrices(records: ScannedFlyerPrice[]): Promise<void> {
    for (const record of records) {
      const key = normalizeItemName(record.itemName);
      if (!this.prices.has(key)) {
        this.prices.set(key, []);
      }
      this.prices.get(key)!.push(record);
    }
  }

  /**
   * Get the newest valid price for an item at a given store.
   * Returns null if no valid (non-expired) price exists.
   */
  async getPrice(
    itemName: string,
    storeId: string,
  ): Promise<PriceResult | null> {
    const key = normalizeItemName(itemName);
    const records = this.prices.get(key);
    if (!records || records.length === 0) return null;

    // Filter by store and non-expired, then sort by scannedAt descending
    const now = Date.now();
    const valid = records.filter(
      (r) =>
        r.storeId === storeId &&
        (r.validTo === null || r.validTo > now),
    );
    if (valid.length === 0) return null;

    // Return the newest valid price
    const newest = valid.sort((a, b) => b.scannedAt - a.scannedAt)[0];

    const { unitPrice } = normalizeUnitPrice(
      newest.price,
      newest.quantity,
      newest.unit,
    );

    // If the price was on sale in the flyer, pass through the sale info
    const saleInfo = newest.saleInfo ?? null;

    return {
      price: newest.price,
      unitPrice,
      unit: newest.unit,
      saleInfo,
      source: {
        adapterId: this.id,
        tier: this.tier,
        storeId: newest.storeId,
        storeName: newest.storeName,
      },
      timestamp: newest.scannedAt,
      confidence: getConfidenceLevel(newest.confidence),
      ...(newest.validTo !== null ? { validTo: newest.validTo } : {}),
    };
  }

  /**
   * Get prices for multiple items at a given store.
   */
  async getPrices(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    for (const item of items) {
      const price = await this.getPrice(item, storeId);
      if (price) {
        results.set(item, price);
      }
    }
    return results;
  }

  /**
   * Clear all stored flyer prices (for testing / user request).
   */
  clearAllPrices(): void {
    this.prices.clear();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const flyerScanAdapter = new FlyerScanAdapter();
