/**
 * Store discovery — which stores have prices for the user right now.
 *
 * Union of the flyer deals and shelf prices in the user's region (from the
 * relay) and stores with crowd-reported prices, de-duplicated by store ID.
 */

import { flippDealsAdapter } from './flipp-deals-adapter';
import { storePricesAdapter } from './store-prices-adapter';
import { crowdsourcedAdapter } from './crowdsourced';

export interface DiscoveredStore {
  storeId: string;
  storeName: string;
}

const SOURCES = [flippDealsAdapter, storePricesAdapter, crowdsourcedAdapter];

export async function discoverStores(): Promise<DiscoveredStore[]> {
  const lists = await Promise.all(
    SOURCES.map((a) => (a.isAvailable() ? a.getAvailableStores().catch(() => [] as DiscoveredStore[]) : Promise.resolve([]))),
  );
  const seen = new Set<string>();
  const stores: DiscoveredStore[] = [];
  for (const s of lists.flat()) {
    if (seen.has(s.storeId)) continue;
    seen.add(s.storeId);
    stores.push(s);
  }
  return stores;
}
