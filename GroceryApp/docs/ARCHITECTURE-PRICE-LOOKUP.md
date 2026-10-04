# Architecture: Automatic Price Lookup from Grocery List Items

**Tag:** `v1.05` → `v1.06` (proposed)  
**Status:** Design Document  
**Last Updated:** 2026-06-15

---

## 1. Executive Summary

PantryRun already has substantial pricing infrastructure — a price store, adapter registry with six adapters, deal matching, stop optimization, and inline price display in `ItemRow`. The missing piece is **wiring**: connecting the act of adding/managing grocery list items to automatic, privacy-respecting price lookups with appropriate triggers, caching, and user feedback.

This document covers the trigger mechanism, data flow, display integration, privacy model, and specific file changes needed.

---

## 2. Current State — What Already Works

### 2.1 Price Display Pipeline (✅ Wired)

```
GroceryListScreen
  → usePriceStore.loadPricesForAllStores(items, storeIds)  [line 188-200]
  → getItemPrice(itemId) callback                           [line 128-152]
  → <ItemRow price={getItemPrice(item.id)} />               [line 698, 713]
  → <PriceBadge price={price} />                            [ItemRow.tsx:187]
```

- **`src/screens/GroceryListScreen.tsx`** — Already calls `loadPricesForAllStores` in a `useEffect` triggered by `Object.keys(items).length`, `listId`, `isFocused`, and `availableStores` changes.
- **`src/components/ItemRow.tsx`** — Already accepts `price?: PriceResult | null` and `priceLoading?: boolean` props.
- **`src/components/PriceBadge.tsx`** — Fully implemented: regular price, sale price with strikethrough, unit price, source badge, loading shimmer.
- ~~`src/components/StoreTotalBar.tsx`~~ — removed (was unused); per-store coverage and subtotals now come from `planBasket()` (see `PRICE_COMPARISON.md`).
- **`src/components/StopOptimizer.tsx`** — Route optimization using `perStorePrices`.

### 2.2 Price Engine (✅ Implemented)

| File | Role |
|------|------|
| `src/pricing/price-store.ts` | Zustand store: `loadPrices`, `loadSinglePrice`, `loadPricesForAllStores`, `submitCrowdPrice` |
| `src/pricing/registry.ts` | Adapter chain with tier fallback: official → flyer → crowd → scraping |
| `src/pricing/adapter.ts` | `PriceAdapter` interface contract |
| `src/pricing/crowdsourced.ts` | In-memory crowd-sourced prices (always available) |
| `src/pricing/instacart.ts` | Instacart API adapter |
| `src/pricing/scraping.ts` | Web scraping adapter |
| `src/pricing/flipp-deals-adapter.ts` | Flipp flyer deals via Turso |
| `src/pricing/cloud-flyer.ts` | Cloud-based flyer data |
| `src/pricing/flyer-scan.ts` | Local flyer scan OCR |
| `src/pricing/normalizer.ts` | Unit price normalization + sale detection |
| `src/pricing/types.ts` | `PriceResult`, `SaleInfo`, `PriceSource`, `ConfidenceLevel` |
| `src/services/dealMatcher.ts` | Keyword-based deal matching + greedy set-cover store optimizer |
| `src/services/dealCache.ts` | In-memory session cache for Flipp deals |

### 2.3 Privacy Controls (✅ Implemented)

- `settings.pricingOptedIn` — Must be `true` before any lookups (checked in `price-store.ts` lines 72, 120, 149)
- `settings.priceServiceEnabled` — Master toggle
- `src/screens/PrivacyScreen.tsx` — Dedicated opt-in toggle with disclosure dialog
- `src/screens/SettingsScreen.tsx` — Pricing section with individual adapter toggles

### 2.4 What's Missing (Gaps)

| Gap | Impact |
|-----|--------|
| **No on-add trigger** — `addItem()` in `useGroceryStore` doesn't fire a price lookup. The batch `useEffect` in GroceryListScreen catches it on next render, but reloads ALL items. | Delayed feedback, unnecessary network/CPU |
| **No debounced single-item lookup** — Adding "Milk" could immediately query for just that item instead of reloading the full list | Wasted work |
| **No price freshness tracking** — No way to know if a price is from today or 3 weeks ago at the item level | Stale data risk |
| **No manual refresh** — User can't pull-to-refresh or tap to re-fetch prices | No user agency |
| **dealMatcher vs flipp-deals-adapter duplication** — Both implement keyword extraction and matching independently | Maintenance burden |
| **Privacy: raw item names to external adapters** — `normalizeItemName` only lowercases/trims. Third-party adapters (instacart, scraping) receive plaintext item names | Privacy leak for non-local sources |

---

## 3. Trigger Mechanism — When Should Prices Be Fetched?

### 3.1 Decision: Hybrid Strategy

| Trigger | When | Behavior |
|---------|------|----------|
| **On list open** | `GroceryListScreen` mounts or regains focus | Batch lookup for all unchecked items across all available stores (existing `useEffect`) |
| **On item add** | `addItem()` succeeds in `useGroceryStore` | Debounced single-item lookup via `loadSinglePrice` for each available store |
| **On pull-to-refresh** | User pulls down on the list | Force-refresh all prices (new feature) |
| **Daily staleness check** | On list open, if prices are >24h old | Background re-fetch for stale items only |
| **NO periodic background** | — | Avoids battery drain; prices change slowly enough that on-open is sufficient |

### 3.2 Debounce Strategy for On-Add

When multiple items are added in quick succession (e.g., voice input parsing 5 items), debounce with a 500ms window:

```
addItem("Milk")    →  schedule lookup at t+500ms
addItem("Bread")   →  reset timer to t+500ms
addItem("Eggs")    →  reset timer to t+500ms
                      t+500ms → batch lookup for [Milk, Bread, Eggs]
```

---

## 4. Data Flow

### 4.1 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER ACTION                                  │
│  AddItemSheet → addItem() → useGroceryStore                         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    OPT-IN CHECK                                      │
│  settings.pricingOptedIn && settings.priceServiceEnabled             │
│  → If false: skip silently, no error                                 │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (true)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  ITEM NAME PREPARATION                               │
│  1. Extract item name: item.name                                     │
│  2. Normalize: lowercase, trim, strip punctuation                    │
│  3. For LOCAL adapters (crowdsourced, flyer-scan):                   │
│     → Use normalized name directly                                   │
│  4. For EXTERNAL adapters (instacart, scraping, relay):              │
│     → Hash normalized name: SHA-256(normalized) → hex prefix (8ch)  │
│     → Send only hash + storeId to external source                    │
│     → Match results back by hash                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│              PRICE REGISTRY QUERY                                    │
│  priceRegistry.getAllPrices(items, storeId)                          │
│    → For each adapter (tier order):                                  │
│      1. Check adapter.isAvailable() && adapterEnabled[id]            │
│      2. Call adapter.getPrices(normalizedNames, storeId)             │
│      3. First non-null result wins per item                          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 RESULT PROCESSING                                    │
│  For each PriceResult:                                               │
│    1. Normalize unit price (normalizer.ts)                           │
│    2. Detect sales (compare vs history if available)                 │
│    3. Set confidence level based on source tier + freshness          │
│    4. Store in priceStore.prices[itemId]                             │
│    5. Store in priceStore.perStorePrices[storeId][itemId]            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    UI DISPLAY                                        │
│  GroceryListScreen                                                   │
│    → getItemPrice(itemId) → considers selectedStoreId, route         │
│    → <ItemRow price={...} priceLoading={...} />                      │
│    → <PriceBadge /> renders inline                                   │
│    → <StoreTotalBar /> updates cart totals                           │
│    → <StopOptimizer /> updates route proposals                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 On-Add Flow (New)

```
useGroceryStore.addItem(itemData)
  │
  ├── yjsAddItem(listId, newItem)          ← existing
  ├── set(state => ({ items: {...} }))     ← existing
  ├── sendFamilyNotification(...)          ← existing (fire-and-forget)
  │
  └── NEW: schedulePriceLookup(newItem)
        │
        ├── addToPendingBatch(newItem)     ← adds to debounce buffer
        └── debounceTimer = setTimeout(500ms, () => {
              flushPendingBatch()
            })

flushPendingBatch()
  │
  ├── const pending = drainPendingBatch()
  ├── const settings = getSettings()
  ├── if (!settings.pricingOptedIn || !settings.priceServiceEnabled) return
  │
  ├── const storeIds = await getAvailableStoreIds()  ← from flippDealsAdapter
  │
  └── for each storeId:
        priceStore.loadPrices(pending, storeId)
```

### 4.3 Batch Refresh Flow (On List Open — Existing)

Already implemented in `GroceryListScreen.tsx` lines 188-200. No changes needed for the basic flow. Enhancement: add staleness check.

### 4.4 Pull-to-Refresh Flow (New)

```
User pulls down on SectionList
  │
  └── handleRefresh()
        │
        ├── setRefreshing(true)
        ├── priceStore.clearPrices()
        ├── priceStore.clearPerStorePrices()
        ├── await priceStore.loadPricesForAllStores(items, storeIds)
        └── setRefreshing(false)
```

---

## 5. Privacy Handling

### 5.1 Current Privacy Model

| Source Type | What Leaves the Device | Current Status |
|-------------|----------------------|----------------|
| **Crowdsourced** (local) | Nothing — in-memory only | ✅ Private |
| **Flyer Scan** (local OCR) | Nothing — local processing | ✅ Private |
| **Flipp Deals** (Turso) | Postal code FSA prefix (3 chars) | ⚠️ Area-level location |
| **Cloud Flyer** (relay) | Ciphertext listId + storeId + hashed names | ✅ Privacy-preserving |
| **Instacart** (API) | Raw item names + storeId | ❌ Plaintext leak |
| **Scraping** (web) | Raw item names in URL/request | ❌ Plaintext leak |

### 5.2 Proposed Privacy Enhancements

#### 5.2.1 Item Name Hashing for External Adapters

For adapters with `tier === 'scraping'` or external API calls:

```typescript
// src/pricing/privacy.ts (NEW FILE)

import { sha256 } from '@noble/hashes/sha256';

/**
 * Normalize and hash an item name for external lookups.
 * Returns first 12 hex chars of SHA-256 for lookup key matching.
 * 
 * Only used for external (non-local) adapters.
 * Local adapters (crowdsourced, flyer-scan) use plaintext normalized names.
 */
export function hashItemName(name: string): string {
  const normalized = name.toLowerCase().trim().replace(/\s+/g, ' ');
  const hash = sha256(new TextEncoder().encode(normalized));
  return Array.from(hash.slice(0, 6))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Check if an adapter requires hashed item names.
 * Local adapters can use plaintext; remote adapters should use hashes.
 */
export function adapterRequiresHash(adapterId: string): boolean {
  const localAdapters = new Set(['crowdsourced', 'flyer-scan']);
  return !localAdapters.has(adapterId);
}
```

#### 5.2.2 Tiered Privacy in Registry

The `PriceRegistry.getPrice()` and `getAllPrices()` methods should pass the appropriate name form per adapter:

```typescript
// In registry.ts — enhanced getAllPrices
for (const adapter of this.adapters) {
  if (!enabled[adapter.id] || !adapter.isAvailable()) continue;

  const useHash = adapterRequiresHash(adapter.id);
  const names = useHash 
    ? items.map(hashItemName) 
    : items;
  
  const batch = await adapter.getPrices(names, storeId);
  // ... match results back to original item names
}
```

#### 5.2.3 Privacy-First Defaults

- External adapter lookups require explicit per-adapter opt-in (already implemented via `adapterEnabled` map)
- Default: all external adapters disabled, only local adapters enabled
- First-time pricing opt-in shows disclosure: "Item names are sent to price sources to find deals. Local sources keep data on-device."

### 5.3 What Stays Local Always

- Item IDs (UUIDs, meaningless externally)
- List structure, categories, quantities
- Checked/unchecked state
- Family member assignments

### 5.3 What May Leave the Device (Only with Opt-In)

- Normalized item names (or hashes for privacy-preserving adapters)
- Store IDs (e.g., "no-frills", "loblaws")
- Postal code FSA prefix (3 chars, for Flipp deals)

---

## 6. Display Design

### 6.1 Inline Price Badge (Existing — No Changes)

Already implemented in `PriceBadge.tsx`. Shows:
- Regular price: `$3.49`
- Sale: ~~$4.99~~ $3.49 with savings badge
- Unit price: `$1.50/100g`
- Source badge: colored pill ("Crowd", "Instacart", "Flyer")
- Loading shimmer

### 6.2 Store Name in Price Badge (Enhancement)

Currently `PriceBadge` shows price + source but not the store name. Enhancement:

```tsx
// In PriceBadge — add store name line
{price.source.storeName && (
  <Text style={styles.storeName}>@ {price.source.storeName}</Text>
)}
```

### 6.3 Pull-to-Refresh Indicator (New)

Wrap `SectionList` in `RefreshControl`:

```tsx
<SectionList
  refreshControl={
    <RefreshControl
      refreshing={isRefreshing}
      onRefresh={handleRefreshPrices}
      tintColor={theme.primary}
    />
  }
  // ...existing props
/>
```

### 6.4 Price Confidence Indicator (Enhancement)

Show a subtle indicator for price freshness:

| Confidence | Display |
|-----------|---------|
| `real_time` | No indicator (default) |
| `recent` | Tiny clock icon |
| `stale` | Faded price text |
| `estimated` | "~" prefix on price |

### 6.5 No Separate "Deals" Section

**Decision:** Keep prices inline per item (existing design). A separate deals section would fragment the shopping experience. The `StoreTotalBar` and `StopOptimizer` already surface deal-level insights.

---

## 7. Specific File Changes

### Phase 1: On-Add Trigger + Debounce (Core Wiring)

| File | Change | Lines Affected |
|------|--------|---------------|
| **`src/state/useGroceryStore.ts`** | Add `schedulePriceLookup` call after `addItem` succeeds. Import `usePriceStore` or call it directly. Add debounce buffer (module-level `pendingItems` array + timer). | After line 121 (`return newItem`) |
| **`src/pricing/price-store.ts`** | Add `loadPricesDebounced(items, storeIds, delay?)` method that debounces internally. Add `lastLookupAt: Record<string, number>` to state for freshness tracking. | New state field + new method |
| **`src/screens/GroceryListScreen.tsx`** | Enhance existing `useEffect` (line 188) to skip items with fresh prices (<1h old). Add `RefreshControl` to `SectionList`. | Lines 188-200, ~685 |

### Phase 2: Privacy Hashing

| File | Change |
|------|--------|
| **`src/pricing/privacy.ts`** | **NEW FILE.** `hashItemName()`, `adapterRequiresHash()`, `normalizeForLookup()`. |
| **`src/pricing/registry.ts`** | Modify `getPrice()` and `getAllPrices()` to use `normalizeForLookup()` per adapter tier. Pass original names for result mapping. |
| **`src/pricing/instacart.ts`** | Update `getPrice`/`getPrices` to accept hashed names. Build reverse-lookup map for results. |
| **`src/pricing/scraping.ts`** | Same as instacart. |

### Phase 3: Price Freshness + Manual Refresh

| File | Change |
|------|--------|
| **`src/pricing/price-store.ts`** | Add `priceTimestamps: Record<string, number>` tracking when each item's price was last fetched. Add `isStale(itemId, maxAgeMs)` helper. Add `refreshAllPrices()` action. |
| **`src/screens/GroceryListScreen.tsx`** | Add `isRefreshing` state. Add `RefreshControl` to `SectionList`. Wire to `refreshAllPrices()`. Add staleness check in price display `useEffect`. |
| **`src/components/PriceBadge.tsx`** | Add optional `confidence` prop. Show "~" prefix for `estimated`, faded style for `stale`. |

### Phase 4: Consolidate Deal Matching

| File | Change |
|------|--------|
| **`src/pricing/flipp-deals-adapter.ts`** | Extract shared `extractKeywords()` and `matchScore()` to a shared utility. |
| **`src/services/dealMatcher.ts`** | Import shared matching utility instead of duplicating. |
| **`src/pricing/matching.ts`** | **NEW FILE.** Shared keyword extraction, stop-word filtering, and match scoring. Used by both `flipp-deals-adapter.ts` and `dealMatcher.ts`. |

### Phase 5: Settings UI Enhancement

| File | Change |
|------|--------|
| **`src/screens/SettingsScreen.tsx`** | Add "Price Sources" sub-section showing each adapter with enable/disable toggle + last-sync timestamp. Add "Clear Price Cache" button. |
| **`src/screens/PrivacyScreen.tsx`** | Add explanation of what data each adapter type sends. Show per-adapter privacy level (local/remote). |

---

## 8. State Shape Changes

### 8.1 `usePriceStore` — New Fields

```typescript
export interface PriceState {
  // Existing
  prices: Record<string, PriceResult>;
  perStorePrices: Record<string, Record<string, PriceResult>>;
  isLoading: boolean;
  itemLoading: Record<string, boolean>;
  error: string | null;

  // NEW — Phase 3
  /** When each item's price was last fetched (epoch ms) */
  priceTimestamps: Record<string, number>;
  /** Whether pull-to-refresh is active */
  isRefreshing: boolean;

  // Existing actions (unchanged API)
  loadPrices: (...) => Promise<void>;
  loadSinglePrice: (...) => Promise<void>;
  loadPricesForAllStores: (...) => Promise<void>;
  submitCrowdPrice: (...) => Promise<void>;
  getItemPrice: (...) => PriceResult | null;
  getStoreIdsWithPrices: () => string[];
  clearPrices: () => void;
  clearPerStorePrices: () => void;
  clearError: () => void;

  // NEW actions
  /** Debounced batch load — coalesces rapid additions */
  loadPricesDebounced: (
    items: { id: string; name: string; storeId?: string }[],
    storeIds: string[],
    debounceMs?: number,
  ) => void;
  /** Check if a price is stale (older than maxAgeMs) */
  isPriceStale: (itemId: string, maxAgeMs?: number) => boolean;
  /** Force-refresh all prices for the current list */
  refreshAllPrices: (
    items: { id: string; name: string }[],
    storeIds: string[],
  ) => Promise<void>;
}
```

### 8.2 `useGroceryStore` — No Schema Changes

The `addItem` method remains unchanged in signature. The price lookup trigger is internal and fire-and-forget.

---

## 9. Performance Considerations

### 9.1 Batch vs Single

| Scenario | Strategy | Rationale |
|----------|----------|-----------|
| List open with 20 items | Batch `loadPricesForAllStores` | Single pass through adapter chain |
| Adding 1 item to existing list | Debounced `loadSinglePrice` per store | Quick feedback, minimal work |
| Adding 5 items via voice | Debounced batch after 500ms | Coalesce into single batch request |
| Pull-to-refresh | Full batch reload | User explicitly requested freshness |

### 9.2 Adapter Caching

- **`dealCache.ts`** — Already caches Flipp deals by FSA (in-memory, 10 entries max)
- **`flipp-deals-adapter.ts`** — Already has `_merchantDealsCache` keyed by FSA
- **`crowdsourced.ts`** — In-memory Map, no disk I/O
- **Price store** — Already caches results in Zustand state (`prices`, `perStorePrices`)

### 9.3 Skip Re-Lookup if Fresh

```typescript
// In GroceryListScreen useEffect
const FRESHNESS_THRESHOLD = 60 * 60 * 1000; // 1 hour
const staleItems = visibleItems.filter(item => {
  const ts = priceTimestamps[item.id];
  return !ts || Date.now() - ts > FRESHNESS_THRESHOLD;
});
if (staleItems.length === 0) return; // all prices fresh, skip lookup
```

---

## 10. Error Handling

| Error | Handling |
|-------|----------|
| Adapter returns null | Skip to next adapter in chain (existing) |
| Adapter throws | Caught in `price-store.ts`, sets `error` state, continues with other adapters |
| All adapters fail | `prices` remains empty; `PriceBadge` renders nothing (existing) |
| Network unavailable | Local adapters (crowdsourced, flyer-scan) still work; external adapters return null |
| Turso unavailable | `flipp-deals-adapter.isAvailable()` returns false; registry skips it |
| Debounce timer fires with 0 items | No-op, no network call |

---

## 11. Testing Strategy

### 11.1 Unit Tests

| Test | File |
|------|------|
| `hashItemName` produces consistent hashes | `src/pricing/__tests__/privacy.test.ts` |
| `adapterRequiresHash` returns correct per adapter | `src/pricing/__tests__/privacy.test.ts` |
| Debounce coalesces rapid additions | `src/state/__tests__/useGroceryStore.test.ts` |
| Staleness check correctly identifies old prices | `src/pricing/__tests__/price-store.test.ts` |
| `loadPricesDebounced` calls batch after delay | `src/pricing/__tests__/price-store.test.ts` |

### 11.2 Integration Tests

| Test | File |
|------|------|
| Add item → price appears after debounce | `src/screens/__tests__/GroceryListScreen.test.tsx` |
| Pull-to-refresh clears and reloads prices | `src/screens/__tests__/GroceryListScreen.test.tsx` |
| Opt-in disabled → no price lookups fire | `src/pricing/__tests__/integration.test.ts` |
| Fresh prices (<1h) not re-fetched on focus | `src/screens/__tests__/GroceryListScreen.test.tsx` |

---

## 12. Implementation Phases

### Phase 1: Core Wiring (1-2 days)
- Add debounce buffer to `useGroceryStore.addItem()`
- Add `loadPricesDebounced` to `price-store.ts`
- Wire on-add trigger after `addItem` succeeds
- **No UI changes needed** — existing PriceBadge/ItemRow already display prices

### Phase 2: Privacy Hashing (1 day)
- Create `src/pricing/privacy.ts`
- Update registry to hash names for external adapters
- Update instacart/scraping adapters to accept hashed keys

### Phase 3: Freshness + Refresh (1 day)
- Add `priceTimestamps` to price store
- Add staleness check to GroceryListScreen `useEffect`
- Add `RefreshControl` to SectionList
- Add `refreshAllPrices` action

### Phase 4: Consolidate Matching (0.5 day)
- Extract shared matching utility from `flipp-deals-adapter.ts` and `dealMatcher.ts`
- Create `src/pricing/matching.ts`

### Phase 5: Settings Enhancement (0.5 day)
- Add per-adapter status + last-sync to SettingsScreen
- Enhance PrivacyScreen with per-adapter data flow explanation

---

## 13. File Inventory

### New Files

| File | Purpose |
|------|---------|
| `src/pricing/privacy.ts` | Item name hashing, adapter privacy classification |
| `src/pricing/matching.ts` | Shared keyword extraction and match scoring |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `src/state/useGroceryStore.ts` | 1 | Add debounce buffer + price lookup trigger in `addItem` |
| `src/pricing/price-store.ts` | 1, 3 | Add `loadPricesDebounced`, `priceTimestamps`, `refreshAllPrices`, `isPriceStale` |
| `src/screens/GroceryListScreen.tsx` | 1, 3 | Staleness check in useEffect, `RefreshControl`, `isRefreshing` state |
| `src/pricing/registry.ts` | 2 | Hash names for external adapters via `normalizeForLookup` |
| `src/pricing/instacart.ts` | 2 | Accept hashed name keys |
| `src/pricing/scraping.ts` | 2 | Accept hashed name keys |
| `src/pricing/flipp-deals-adapter.ts` | 4 | Import shared matching utility |
| `src/services/dealMatcher.ts` | 4 | Import shared matching utility |
| `src/components/PriceBadge.tsx` | 3 | Add confidence indicator, store name display |
| `src/screens/SettingsScreen.tsx` | 5 | Per-adapter status, clear cache button |
| `src/screens/PrivacyScreen.tsx` | 5 | Per-adapter data flow explanation |

### Unchanged Files (Already Working)

| File | Why No Changes Needed |
|------|----------------------|
| `src/components/ItemRow.tsx` | Already accepts `price` + `priceLoading` props |
| `src/components/StoreTotalBar.tsx` | Already reads from `perStorePrices` |
| `src/components/StopOptimizer.tsx` | Already uses `perStorePrices` |
| `src/pricing/crowdsourced.ts` | Local adapter, no hashing needed |
| `src/pricing/flyer-scan.ts` | Local adapter, no hashing needed |
| `src/pricing/cloud-flyer.ts` | Already uses relay with ciphertext |
| `src/pricing/normalizer.ts` | No changes needed |
| `src/pricing/types.ts` | No schema changes needed |
| `src/services/dealCache.ts` | Caching layer unchanged |
| `src/screens/AddItemSheet.tsx` | Calls `addItem()` which handles the trigger |

---

## 14. Open Questions

1. **Should the on-add price lookup be cancellable?** If the user adds then immediately deletes an item, should the pending lookup be cancelled? *Recommendation: yes, check `!item.isDeleted` before firing lookup.*

2. **Should checked-off items retain their prices?** Currently yes (prices stay in `priceStore.prices`). *Recommendation: keep as-is; checked items in "Got It" section still show prices for receipt comparison.*

3. **Rate limiting for external adapters?** If the user is adding items rapidly, we should cap external API calls. *Recommendation: the 500ms debounce handles this. Additionally, skip external lookups if the adapter was queried in the last 30 seconds.*

4. **Offline-first priority?** The crowdsourced adapter is always available. Should it be preferred when offline? *Recommendation: yes — the registry already tries adapters in tier order, and `isAvailable()` checks should include network status.*

---

## 15. Success Metrics

| Metric | Target |
|--------|--------|
| Time from item add to price display | <2 seconds (with debounce) |
| % of items with price match | >60% for common grocery items |
| External data sent per lookup | 0 plaintext item names (hash only) |
| Battery impact | Negligible (no background polling) |
| User opt-in for pricing | Track via anonymous analytics |
