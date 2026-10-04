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
 *
 * FRESHNESS & RACES: every lookup takes a sequence number when it starts.
 * A result is applied to a (store, item) only if no newer lookup or price
 * edit has already been applied there, so a slow older request can never
 * revert a newer price. When a store answers without an item it had
 * before, the old price is kept only as a withdrawn record (ineligible,
 * shown as "No longer offered"). When a store's lookup fails, its prices
 * stay as last-known values flagged `refreshFailedAt` — usable for an
 * estimate, never verified. A refresh never wipes prices first.
 */

import { create } from 'zustand';
import type { PriceResult, SubmittedPrice } from './types';
import { priceRegistry } from './registry';
import { crowdsourcedAdapter } from './crowdsourced';

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
  /** storeId → message of its last failed lookup (cleared when it next answers) */
  storeErrors: Record<string, string>;

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

// ─── Request ordering ───────────────────────────────────────────────────────

let seqCounter = 0;
/** (store, item) → sequence number of the lookup whose result is applied */
const appliedSeq = new Map<string, number>();

function nextSeq(): number {
  return ++seqCounter;
}

function seqKey(storeId: string, itemId: string): string {
  return `${storeId}\u0000${itemId}`;
}

/** True (and recorded) when lookup `seq` is at least as new as what's applied. */
function claim(storeId: string, itemId: string, seq: number): boolean {
  const key = seqKey(storeId, itemId);
  if ((appliedSeq.get(key) ?? 0) > seq) return false;
  appliedSeq.set(key, seq);
  return true;
}

function withdrawn(pr: PriceResult): PriceResult {
  return { ...pr, unavailable: 'withdrawn' };
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
  storeErrors: {},

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
    const seq = nextSeq();
    try {
      set((state) => ({
        itemLoading: { ...state.itemLoading, [itemId]: true },
      }));

      const result = await priceRegistry.getPrice(itemName, storeId);
      set((state) => {
        const itemLoading = { ...state.itemLoading, [itemId]: false };
        if (!claim(storeId, itemId, seq)) return { itemLoading };
        const storePrices = { ...(state.perStorePrices[storeId] ?? {}) };
        const previous = storePrices[itemId];
        if (result) storePrices[itemId] = result;
        else if (previous && !previous.unavailable) storePrices[itemId] = withdrawn(previous);
        else return { itemLoading };
        return {
          prices: result ? { ...state.prices, [itemId]: result } : state.prices,
          perStorePrices: { ...state.perStorePrices, [storeId]: storePrices },
          itemLoading,
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
    const seq = nextSeq();
    try {
      /** Stores that answered — only these may overwrite or withdraw prices. */
      const results: Record<string, Record<string, PriceResult>> = {};
      const failures: Record<string, string> = {};

      await Promise.all(
        storeIds.map(async (storeId: string) => {
          try {
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
          } catch (err) {
            failures[storeId] = err instanceof Error ? err.message : String(err);
          }
        }),
      );

      const now = Date.now();
      set((state) => {
        const perStorePrices = { ...state.perStorePrices };
        const prices = { ...state.prices };
        const priceTimestamps = { ...state.priceTimestamps };
        const storeErrors = { ...state.storeErrors };

        for (const [storeId, storeResult] of Object.entries(results)) {
          delete storeErrors[storeId];
          const merged = { ...(perStorePrices[storeId] ?? {}) };
          for (const item of items) {
            if (!claim(storeId, item.id, seq)) continue; // a newer lookup or edit already landed
            const result = storeResult[item.id];
            if (result) {
              merged[item.id] = result;
              prices[item.id] = result;
              priceTimestamps[item.id] = now;
            } else if (merged[item.id] && !merged[item.id].unavailable) {
              // The store answered and no longer lists it: never keep it as live.
              merged[item.id] = withdrawn(merged[item.id]);
            }
          }
          if (Object.keys(merged).length > 0) perStorePrices[storeId] = merged;
          else delete perStorePrices[storeId];
        }

        for (const [storeId, message] of Object.entries(failures)) {
          storeErrors[storeId] = message;
          const existing = perStorePrices[storeId];
          if (!existing) continue;
          const marked = { ...existing };
          for (const item of items) {
            const pr = marked[item.id];
            if (pr && seq >= (appliedSeq.get(seqKey(storeId, item.id)) ?? 0)) {
              // Last-known price: still shown and usable for an estimate, never verified.
              marked[item.id] = { ...pr, refreshFailedAt: now };
            }
          }
          perStorePrices[storeId] = marked;
        }

        const failed = Object.keys(failures);
        return {
          prices,
          perStorePrices,
          priceTimestamps,
          storeErrors,
          ...(failed.length > 0
            ? {
                error: `Couldn't refresh ${failed.length} of ${storeIds.length} stores (${failures[failed[0]]}) — showing last-known prices`,
              }
            : {}),
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
    appliedSeq.clear();
    set({ perStorePrices: {}, storeErrors: {} });
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
      // Re-fetch without wiping first: a store that fails keeps its prices as
      // labelled last-known values instead of leaving nothing (or worse,
      // looking freshly verified).
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