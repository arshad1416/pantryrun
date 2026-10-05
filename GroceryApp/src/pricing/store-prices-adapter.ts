/**
 * StorePricesAdapter — regular shelf prices for the user's region.
 *
 * Source: the operator's shelf-price scraper (store_prices_scrape.py →
 * Turso store_prices; see docs/ARCHITECTURE-GROCERY-SCRAPER.md), served by
 * the relay at GET /api/prices/shelf?fsa= (see live-prices.ts). The app
 * never reads Turso itself.
 *
 * Prices scraped more than 7 days ago are dropped. Scraped prices are usable
 * but never "verified" (eligibility.ts): the scraper doesn't report branch,
 * channel or stock. Registered after FlippDealsAdapter so a flyer deal for
 * the same item wins the registry's first-match lookup.
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult } from './types';
import { getSettings } from '../config/settings';
import {
  findBestRow,
  loadShelfPrices,
  normalizeFsa,
  shelfPriceToPriceResult,
  shelfStoreId,
  type ShelfPriceRow,
  type Snapshot,
} from './live-prices';

function userFsa(): string {
  return normalizeFsa(getSettings().flippFsa);
}

function nameOf(row: ShelfPriceRow): string {
  return row.name || row.name_clean || '';
}

function priceOf(row: ShelfPriceRow): number | null {
  return row.price_real ?? (parseFloat(row.price) || null);
}

export class StorePricesAdapter implements PriceAdapter {
  id = 'store-prices';
  name = 'Store Shelf Prices';
  tier = 'scraping' as const;

  /** Needs a relay; the relay answers 503 until its operator configures prices. */
  isAvailable(): boolean {
    return !!getSettings().relayUrl;
  }

  private async pricesFor(storeId: string): Promise<{ rows: ShelfPriceRow[]; snap: Snapshot<ShelfPriceRow> } | null> {
    const snap = await loadShelfPrices(userFsa());
    if (!snap) return null;
    return { rows: snap.rows.filter((r) => shelfStoreId(r) === storeId), snap };
  }

  async getPrice(itemName: string, storeId: string): Promise<PriceResult | null> {
    const prices = await this.pricesFor(storeId);
    if (!prices) return null;
    const row = findBestRow(itemName, prices.rows, nameOf, priceOf);
    return row ? shelfPriceToPriceResult(row, prices.snap) : null;
  }

  async getPrices(items: string[], storeId: string): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    const prices = await this.pricesFor(storeId);
    if (!prices) return results;
    for (const itemName of items) {
      const row = findBestRow(itemName, prices.rows, nameOf, priceOf);
      const result = row ? shelfPriceToPriceResult(row, prices.snap) : null;
      if (result) results.set(itemName, result);
    }
    return results;
  }

  /** Stores with scraped shelf prices in the user's region. */
  async getAvailableStores(): Promise<{ storeId: string; storeName: string }[]> {
    const snap = await loadShelfPrices(userFsa());
    const stores = new Map<string, string>();
    for (const row of snap?.rows ?? []) stores.set(shelfStoreId(row), row.store_name || row.store_id);
    return Array.from(stores, ([storeId, storeName]) => ({ storeId, storeName })).sort((a, b) =>
      a.storeName.localeCompare(b.storeName),
    );
  }
}

export const storePricesAdapter = new StorePricesAdapter();
