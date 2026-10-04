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
import { invalidateCache as invalidateTripPlanCache } from './trip-plan-cache';

// ─── State Shape ────────────────────────────────────────────────────────────

export interface PriceState {
  /** Prices keyed by itemId */
  prices: Record<string, PriceResult>;
  /** Per-store prices: storeId → itemId → PriceResult */
  perStorePrices: Record<string, Record<string, PriceResult>>;
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

}

// ─── Store ──────────────────────────────────────────────────────────────────

export const usePriceStore = create<PriceState>((set, get) => ({
  prices: {},
  perStorePrices: {},
  isLoading: false,
  itemLoading: {},
  error: null,
  priceTimestamps: {},
  isRefreshing: false,

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
    try {
      set((state) => ({
        itemLoading: { ...state.itemLoading, [itemId]: true },
      }));

      const result = await priceRegistry.getPrice(itemName, storeId);
      if (result) {
        invalidateTripPlanCache();
        set((state) => ({
          prices: { ...state.prices, [itemId]: result },
          perStorePrices: {
            ...state.perStorePrices,
            [storeId]: { ...(state.perStorePrices[storeId] ?? {}), [itemId]: result },
          },
          itemLoading: { ...state.itemLoading, [itemId]: false },
          priceTimestamps: { ...state.priceTimestamps, [itemId]: Date.now() },
        }));
      } else {
        set((state) => ({
          itemLoading: { ...state.itemLoading, [itemId]: false },
        }));
      }
    } catch {
      set((state) => ({
        itemLoading: { ...state.itemLoading, [itemId]: false },
      }));
    }
  },

  loadPricesForAllStores: async (items, storeIds) => {
    try {
      /** Stores that answered — only these may overwrite or drop prices. */
      const results: Record<string, Record<string, PriceResult>> = {};

      const outcomes = await Promise.allSettled(
        storeIds.map(async (storeId: string) => {
          const itemNames = items.map((i) => i.name);
          // NOTE: never log item names here — plaintext item names in logs
          // would contradict the hashed-lookup privacy contract (AC-14).
          const priceMap = await priceRegistry.getAllPrices(itemNames, storeId);
          const storeResult: Record<string, PriceResult> = {};
          for (const item of items) {
            const result = priceMap.get(item.name);
            if (result) {
              storeResult[item.id] = result;
            }
          }
          results[storeId] = storeResult;
        })
      );

      const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult | undefined;
      if (rejected) {
        set({
          error: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
        });
      }

      invalidateTripPlanCache();
      const now = Date.now();
      set((state) => {
        // Merge per item: a refetch of some items must not wipe a store's
        // prices for the rest, and a price that's gone (offer ended) must
        // not linger from an earlier fetch.
        const perStorePrices = { ...state.perStorePrices };
        for (const [storeId, storeResult] of Object.entries(results)) {
          const merged = { ...(perStorePrices[storeId] ?? {}) };
          for (const item of items) {
            if (storeResult[item.id]) merged[item.id] = storeResult[item.id];
            else delete merged[item.id];
          }
          if (Object.keys(merged).length > 0) perStorePrices[storeId] = merged;
          else delete perStorePrices[storeId];
        }
        return {
          prices: { ...state.prices, ...Object.values(results).reduce((acc, storePrices) => ({ ...acc, ...storePrices }), {}) },
          perStorePrices,
          priceTimestamps: {
            ...state.priceTimestamps,
            ...Object.fromEntries(
              Object.values(results)
                .flatMap(storePrices => Object.keys(storePrices))
                .map(id => [id, now])
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

      // Refresh the price display for this item
      if (refreshItemId && refreshItemName) {
        const storeId = price.storeId;
        await get().loadSinglePrice(refreshItemId, refreshItemName, storeId);
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
    invalidateTripPlanCache();
    set({ perStorePrices: {} });
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
}));