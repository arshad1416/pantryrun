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
  findCandidateRows,
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

/** Newer flyers first when the same product is listed twice. */
function timeOf(row: FlyerDealRow): number {
  return Date.parse(row.valid_from ?? '') || Date.parse(row.valid_to) || 0;
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
    return (await this.getCandidates([itemName], storeId)).get(itemName)?.[0] ?? null;
  }

  async getPrices(items: string[], storeId: string): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    for (const [item, list] of await this.getCandidates(items, storeId)) results.set(item, list[0]);
    return results;
  }

  /** Ranked deals per item (see findCandidateRows); the basket picks among them. */
  async getCandidates(items: string[], storeId: string): Promise<Map<string, PriceResult[]>> {
    const results = new Map<string, PriceResult[]>();
    const deals = await this.dealsFor(storeId);
    if (!deals) return results;
    for (const itemName of items) {
      const list = findCandidateRows(itemName, deals.rows, (r) => r.name, priceOf, timeOf)
        .map((row) => flyerDealToPriceResult(row, deals.snap))
        .filter((pr): pr is PriceResult => pr !== null);
      if (list.length > 0) results.set(itemName, list);
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
