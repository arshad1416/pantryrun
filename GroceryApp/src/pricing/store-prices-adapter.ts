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
 * channel or stock. The registry gathers these alongside flyer deals and
 * the basket picks the cheapest eligible offer.
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult } from './types';
import { getSettings } from '../config/settings';
import {
  findCandidateRows,
  loadShelfPrices,
  newestPerKey,
  normalizeFsa,
  parseScrapedAt,
  shelfPriceToPriceResult,
  shelfStoreId,
  type ShelfPriceRow,
  type Snapshot,
} from './live-prices';

function userFsa(): string | null {
  return normalizeFsa(getSettings().flippFsa);
}

function nameOf(row: ShelfPriceRow): string {
  return row.name || row.name_clean || '';
}

function priceOf(row: ShelfPriceRow): number | null {
  return row.price_real ?? (parseFloat(row.price) || null);
}

function timeOf(row: ShelfPriceRow): number {
  return parseScrapedAt(row.scraped_at);
}

/** One product at one store, across the feed's week of scrapes and postal codes. */
function productKey(row: ShelfPriceRow): string {
  return `${shelfStoreId(row)}\u0000${(row.name_clean || row.name || '').trim().toLowerCase()}`;
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
    // Newest scrape per product first, so an older cheaper price never wins.
    const rows = newestPerKey(snap.rows.filter((r) => shelfStoreId(r) === storeId), productKey, timeOf);
    return { rows, snap };
  }

  async getPrice(itemName: string, storeId: string): Promise<PriceResult | null> {
    return (await this.getCandidates([itemName], storeId)).get(itemName)?.[0] ?? null;
  }

  async getPrices(items: string[], storeId: string): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    for (const [item, list] of await this.getCandidates(items, storeId)) results.set(item, list[0]);
    return results;
  }

  /** Ranked shelf prices per item (see findCandidateRows); the basket picks among them. */
  async getCandidates(items: string[], storeId: string): Promise<Map<string, PriceResult[]>> {
    const results = new Map<string, PriceResult[]>();
    const prices = await this.pricesFor(storeId);
    if (!prices) return results;
    const now = Date.now();
    for (const itemName of items) {
      const list = findCandidateRows(itemName, prices.rows, nameOf, priceOf, timeOf)
        .map((row) => shelfPriceToPriceResult(row, prices.snap, now))
        .filter((pr): pr is PriceResult => pr !== null);
      if (list.length > 0) results.set(itemName, list);
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
