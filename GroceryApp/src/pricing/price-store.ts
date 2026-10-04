/**
 * Price Subsystem — Zustand Store.
 *
 * Manages pricing state: prices keyed by item ID, loading states,
 * and actions to load/submit prices via the adapter registry.
 *
 * PRIVACY NOTE: Price queries are batched at the item level. When self-hosted,
 * all price lookups stay local. When relay is used, queries go through the relay
 * server which sees only (ciphertext listId, storeId, hashed item names). Item
 * names are normalized (lowercased, trimmed) before hashing for maximum privacy.
 *
 * The pricingOptedIn flag must be true before any price lookups are performed.
 * This flag is managed via the SettingsScreen with a privacy disclosure dialog
 * shown on first enable.
 */

import { create } from 'zustand';
import type { PriceResult, SubmittedPrice } from './types';
import { priceRegistry } from './registry';
import { crowdsourcedAdapter } from './crowdsourced';
import { MAX_STOPS_LIMIT } from './basket-planner';
import { windowFromToday, type ShoppingWindow } from './offer-evidence';

// ─── Write ordering ─────────────────────────────────────────────────────────
// Every fetch and every edit takes a ticket from this counter. A (store, item)
// cell remembers the ticket of the operation that last wrote it, and an
// operation may only write cells no newer operation has touched — so a slow
// response that started before the user's edit can never overwrite it.
let opSeq = 0;
const cellTicket = new Map<string, number>();
let clearedAt = 0;

const cellKey = (storeId: string, itemId: string) => `${storeId}\u0000${itemId}`;

function canWrite(ticket: number, storeId: string, itemId: string): boolean {
  return ticket > clearedAt && (cellTicket.get(cellKey(storeId, itemId)) ?? 0) <= ticket;
}

type PerStore = Record<string, Record<string, PriceResult>>;

/** Apply (store, item) → result|null writes; null removes a vanished offer. */
function applyCells(
  perStorePrices: PerStore,
  ticket: number,
  writes: { storeId: string; itemId: string; result: PriceResult | null }[],
): { next: PerStore; touched: string[] } {
  const next: PerStore = { ...perStorePrices };
  const touched = new Set<string>();
  for (const { storeId, itemId, result } of writes) {
    if (!canWrite(ticket, storeId, itemId)) continue;
    cellTicket.set(cellKey(storeId, itemId), ticket);
    const store = { ...(next[storeId] ?? {}) };
    if (result) store[itemId] = result;
    else delete store[itemId];
    if (Object.keys(store).length > 0) next[storeId] = store;
    else delete next[storeId];
    touched.add(itemId);
  }
  return { next, touched: [...touched] };
}

/** Flat item → price view: the last store (in key order) that has the item. */
function flatten(perStorePrices: PerStore, prev: Record<string, PriceResult>, itemIds: string[]): Record<string, PriceResult> {
  const prices = { ...prev };
  for (const id of itemIds) {
    delete prices[id];
    for (const store of Object.values(perStorePrices)) {
      if (store[id]) prices[id] = store[id];
    }
  }
  return prices;
}

// ─── State Shape ────────────────────────────────────────────────────────────

export interface PriceState {
  /** Prices keyed by itemId (last store wins — use perStorePrices to compare) */
  prices: Record<string, PriceResult>;
  /** Per-store prices: storeId → itemId → PriceResult */
  perStorePrices: PerStore;
  /** Bumped on every change to perStorePrices; part of every plan cache key. */
  priceDataVersion: number;
  /** Loading flag for batch loads */
  isLoading: boolean;
  /** Per-item loading states */
  itemLoading: Record<string, boolean>;
  /** Error message */
  error: string | null;
  /** When each item's price was last fetched (epoch ms) */
  priceTimestamps: Record<string, number>;
  /** Whether pull-to-refresh is active */
  isRefreshing: boolean;

  // ─── Planning inputs (all feed the basket planner) ────────────────────
  /** Store limit for route planning, 1..3. */
  maxStops: number;
  /** Shopping window offers are judged against; null = today only. */
  shoppingWindow: ShoppingWindow | null;
  /** Memberships the shopper holds (enables membership-only prices). */
  memberships: string[];

  // Actions
  loadPrices: (
    items: { id: string; name: string; storeId?: string }[],
    storeId?: string,
  ) => Promise<void>;
  loadSinglePrice: (itemId: string, itemName: string, storeId: string) => Promise<void>;
  loadPricesForAllStores: (
    items: { id: string; name: string }[],
    storeIds: string[],
  ) => Promise<void>;
  submitCrowdPrice: (
    price: Omit<SubmittedPrice, 'id' | 'timestamp'>,
    refreshItemId?: string,
    refreshItemName?: string,
  ) => Promise<void>;
  getItemPrice: (itemId: string) => PriceResult | null;
  getStoreIdsWithPrices: () => string[];
  clearPrices: () => void;
  clearPerStorePrices: () => void;
  clearError: () => void;
  /** Check price age in hours for a given item */
  getPriceAge: (itemId: string) => number | null;
  /** Check if a price is stale (older than maxAgeMs, default 24h) */
  isPriceStale: (itemId: string, maxAgeMs?: number) => boolean;
  /** Force-refresh all prices for the current list */
  refreshAllPrices: (
    items: { id: string; name: string }[],
    storeIds: string[],
  ) => Promise<void>;
  setMaxStops: (maxStops: number) => void;
  setShoppingWindow: (window: ShoppingWindow | null) => void;
  setMemberships: (memberships: string[]) => void;
}

/** The window plans use right now: the chosen one, or today. */
export function effectiveWindow(window: ShoppingWindow | null, now: number): ShoppingWindow {
  return window ?? windowFromToday(now);
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const usePriceStore = create<PriceState>((set, get) => ({
  prices: {},
  perStorePrices: {},
  priceDataVersion: 0,
  isLoading: false,
  itemLoading: {},
  error: null,
  priceTimestamps: {},
  isRefreshing: false,
  maxStops: MAX_STOPS_LIMIT,
  shoppingWindow: null,
  memberships: [],

  loadPrices: async (items, defaultStoreId) => {
    try {
      set({ isLoading: true, error: null });

      // Process items in parallel, grouped by store
      const storeGroups = new Map<string, { id: string; name: string }[]>();

      for (const item of items) {
        const storeId = item.storeId ?? defaultStoreId ?? 'default';
        if (!storeGroups.has(storeId)) {
          storeGroups.set(storeId, []);
        }
        storeGroups.get(storeId)!.push(item);
      }

      const newPrices: Record<string, PriceResult> = {};

      for (const [storeId, groupItems] of storeGroups) {
        const itemNames = groupItems.map((i) => i.name);
        const results = await priceRegistry.getAllPrices(itemNames, storeId);

        for (const groupItem of groupItems) {
          const result = results.get(groupItem.name);
          if (result) {
            newPrices[groupItem.id] = result;
          }
        }
      }

      set((state) => ({
        prices: { ...state.prices, ...newPrices },
        isLoading: false,
        priceTimestamps: {
          ...state.priceTimestamps,
          ...Object.fromEntries(Object.keys(newPrices).map(id => [id, Date.now()])),
        },
      }));
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load prices',
      });
    }
  },

  loadSinglePrice: async (itemId, itemName, storeId) => {
    const ticket = ++opSeq;
    try {
      set((state) => ({
        itemLoading: { ...state.itemLoading, [itemId]: true },
      }));

      const result = await priceRegistry.getPrice(itemName, storeId);
      // The single-store lookup is authoritative for this one cell: a result
      // replaces it, no result removes it, so an edit or a withdrawal shows
      // up in every comparison immediately.
      set((state) => {
        const { next, touched } = applyCells(state.perStorePrices, ticket, [{ storeId, itemId, result }]);
        const changed = touched.length > 0;
        return {
          perStorePrices: next,
          prices: changed ? flatten(next, state.prices, touched) : state.prices,
          priceDataVersion: changed ? state.priceDataVersion + 1 : state.priceDataVersion,
          itemLoading: { ...state.itemLoading, [itemId]: false },
          priceTimestamps: result ? { ...state.priceTimestamps, [itemId]: Date.now() } : state.priceTimestamps,
        };
      });
    } catch {
      set((state) => ({
        itemLoading: { ...state.itemLoading, [itemId]: false },
      }));
    }
  },

  loadPricesForAllStores: async (items, storeIds) => {
    const ticket = ++opSeq;
    try {
      const writes: { storeId: string; itemId: string; result: PriceResult | null }[] = [];

      const outcomes = await Promise.allSettled(
        storeIds.map(async (storeId: string) => {
          const itemNames = items.map((i) => i.name);
          // NOTE: never log item names here — plaintext item names in logs
          // would contradict the hashed-lookup privacy contract (AC-14).
          const priceMap = await priceRegistry.getAllPrices(itemNames, storeId);
          // Only a store that answered may clear cells: a missing result means
          // the offer is gone, and must not survive as a cached price.
          for (const item of items) {
            writes.push({ storeId, itemId: item.id, result: priceMap.get(item.name) ?? null });
          }
        })
      );

      const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult | undefined;
      if (rejected) {
        set({
          error: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
        });
      }

      set((state) => {
        const { next, touched } = applyCells(state.perStorePrices, ticket, writes);
        if (touched.length === 0) return {};
        const now = Date.now();
        return {
          perStorePrices: next,
          prices: flatten(next, state.prices, touched),
          priceDataVersion: state.priceDataVersion + 1,
          priceTimestamps: {
            ...state.priceTimestamps,
            ...Object.fromEntries(
              touched.filter((id) => Object.values(next).some((m) => m[id])).map((id) => [id, now]),
            ),
          },
        };
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load prices for all stores',
      });
    }
  },

  submitCrowdPrice: async (
    price: Omit<SubmittedPrice, 'id' | 'timestamp'>,
    refreshItemId?: string,
    refreshItemName?: string,
  ) => {
    try {
      await crowdsourcedAdapter.submitPrice(price);

      // Refresh the price for this item at this store — this updates the
      // per-store map the comparison reads, not just the flat display map.
      if (refreshItemId && refreshItemName) {
        await get().loadSinglePrice(refreshItemId, refreshItemName, price.storeId);
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to submit price',
      });
    }
  },

  getItemPrice: (itemId) => {
    return get().prices[itemId] ?? null;
  },

  getStoreIdsWithPrices: () => {
    return Object.keys(get().perStorePrices);
  },

  clearPrices: () => {
    set({ prices: {}, error: null, priceTimestamps: {} });
  },

  clearPerStorePrices: () => {
    // Responses already in flight belong to the data being cleared.
    clearedAt = ++opSeq;
    cellTicket.clear();
    set((state) => ({ perStorePrices: {}, priceDataVersion: state.priceDataVersion + 1 }));
  },

  clearError: () => {
    set({ error: null });
  },

  getPriceAge: (itemId) => {
    const ts = get().priceTimestamps[itemId];
    if (!ts) return null;
    return (Date.now() - ts) / (1000 * 60 * 60); // hours
  },

  isPriceStale: (itemId, maxAgeMs = 24 * 60 * 60 * 1000) => {
    const ts = get().priceTimestamps[itemId];
    if (!ts) return true; // no timestamp = stale
    return Date.now() - ts > maxAgeMs;
  },

  refreshAllPrices: async (items, storeIds) => {
    set({ isRefreshing: true, error: null });
    try {
      // Clear existing prices to force fresh lookups
      get().clearPrices();
      get().clearPerStorePrices();

      // Re-fetch all prices
      await get().loadPricesForAllStores(items, storeIds);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to refresh prices',
      });
    } finally {
      set({ isRefreshing: false });
    }
  },

  setMaxStops: (maxStops: number) => {
    set({ maxStops: Math.max(1, Math.min(MAX_STOPS_LIMIT, Math.floor(maxStops) || 1)) });
  },

  setShoppingWindow: (window) => {
    set({ shoppingWindow: window });
  },

  setMemberships: (memberships) => {
    set({ memberships: [...new Set(memberships.map((m) => m.trim()).filter(Boolean))].sort() });
  },
}));
