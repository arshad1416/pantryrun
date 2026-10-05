/**
 * FlippDealsAdapter — this week's flyer deals for the user's region.
 *
 * Source: the operator's flyer scraper (flippscrape.py → Turso flipp_deals),
 * served by the relay at GET /api/prices/deals?fsa= (see live-prices.ts).
 * The app never reads Turso itself.
 *
 * The region's deals are downloaded once per refresh interval and matched
 * to list items on the device. Merchant names ("No Frills") become store
 * IDs ("no-frills"). Every result is a sale with the flyer's own window.
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult } from './types';
import { getSettings } from '../config/settings';
import {
  findBestRow,
  flyerDealToPriceResult,
  flyerOfferEnded,
  loadFlyerDeals,
  normalizeFsa,
  storeIdFromName,
  type FlyerDealRow,
  type Snapshot,
} from './live-prices';

function userFsa(): string {
  return normalizeFsa(getSettings().flippFsa);
}

function priceOf(row: FlyerDealRow): number | null {
  return row.price_real ?? (parseFloat(row.price) || null);
}

export class FlippDealsAdapter implements PriceAdapter {
  id = 'flipp-deals';
  name = 'Flyer Deals';
  tier = 'flyer' as const;

  /** Needs a relay; the relay answers 503 until its operator configures prices. */
  isAvailable(): boolean {
    return !!getSettings().relayUrl;
  }

  private async dealsFor(storeId: string): Promise<{ rows: FlyerDealRow[]; snap: Snapshot<FlyerDealRow> } | null> {
    const snap = await loadFlyerDeals(userFsa());
    if (!snap) return null;
    const now = Date.now();
    return {
      rows: snap.rows.filter((r) => storeIdFromName(r.merchant) === storeId && !flyerOfferEnded(r, now)),
      snap,
    };
  }

  async getPrice(itemName: string, storeId: string): Promise<PriceResult | null> {
    const deals = await this.dealsFor(storeId);
    if (!deals) return null;
    const row = findBestRow(itemName, deals.rows, (r) => r.name, priceOf);
    return row ? flyerDealToPriceResult(row, deals.snap) : null;
  }

  async getPrices(items: string[], storeId: string): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    const deals = await this.dealsFor(storeId);
    if (!deals) return results;
    for (const itemName of items) {
      const row = findBestRow(itemName, deals.rows, (r) => r.name, priceOf);
      const result = row ? flyerDealToPriceResult(row, deals.snap) : null;
      if (result) results.set(itemName, result);
    }
    return results;
  }

  /** Merchants with deals in the user's region this week. */
  async getAvailableStores(): Promise<{ storeId: string; storeName: string }[]> {
    const snap = await loadFlyerDeals(userFsa());
    const stores = new Map<string, string>();
    for (const row of snap?.rows ?? []) stores.set(storeIdFromName(row.merchant), row.merchant);
    return Array.from(stores, ([storeId, storeName]) => ({ storeId, storeName })).sort((a, b) =>
      a.storeName.localeCompare(b.storeName),
    );
  }

  /** Reload on next use (e.g. after the FSA changes). */
  async refresh(): Promise<void> {
    await loadFlyerDeals(userFsa(), true);
  }
}

export const flippDealsAdapter = new FlippDealsAdapter();
