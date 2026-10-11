/**
 * Price Subsystem — Adapter Interface.
 *
 * Defines the PriceAdapter contract that all price source adapters must implement.
 * This uses the Strategy pattern so the registry can iterate adapters in priority order.
 */

import type { PriceResult, PriceSourceTier } from './types';

export interface PriceAdapter {
  /** Unique identifier for this adapter (e.g. 'instacart', 'crowdsourced', 'scraping') */
  id: string;

  /** Human-readable name (e.g. 'Instacart', 'Crowd-Sourced', 'Scraping') */
  name: string;

  /** Tier for fallback ordering: official → crowd → scraping */
  tier: PriceSourceTier;

  /**
   * Check whether this adapter is available for use.
   * Availability depends on configuration (API keys, user opt-in).
   */
  isAvailable(): boolean;

  /**
   * Get the price for a single item at a given store.
   * Returns null if no price data is available.
   */
  getPrice(itemName: string, storeId: string): Promise<PriceResult | null>;

  /**
   * Get prices for multiple items at a given store.
   * Returns a Map of item names to PriceResults.
   * Default implementation calls getPrice for each item.
   */
  getPrices(items: string[], storeId: string): Promise<Map<string, PriceResult>>;

  /**
   * Ranked candidate offers per item at a store, best match first. Adapters
   * that match product names fuzzily return several (e.g. a 4 L jug and a
   * 1 L carton for "milk") so the basket's eligibility and purchase math
   * pick among them. Optional: the registry falls back to getPrices.
   */
  getCandidates?(items: string[], storeId: string): Promise<Map<string, PriceResult[]>>;
}