# Shopping Trip Optimizer — Architecture

> **Superseded (Oct 2026).** `trip-plan.ts`, `trip-plan-cache.ts` and
> `stop-optimizer.ts` were replaced by `src/pricing/basket-planner.ts`. The
> current rules (coverage-first ranking, pack arithmetic, offer validity,
> held lines, merchandise-only savings, max 3 stops) are in
> [`PRICE_COMPARISON.md`](PRICE_COMPARISON.md). This file is kept as design
> history; the defects it shipped with are pinned in
> `__tests__/historical-optimizer-probes.test.ts`.

## Overview

The Trip Optimizer computes the optimal multi-stop shopping plan given a grocery list and per-store prices. It finds the combination of stores that minimizes total cost, assigns each item to its cheapest store within the chosen set, and reports savings vs. buying everything at the most expensive store.

## Data Flow

```
GroceryListScreen
  ├── perStorePrices (from price-store via loadPricesForAllStores)
  ├── filteredUncheckedItems
  └── StopOptimizer (extended)
        ├── MaxStopsStepper → maxStops state
        ├── computeTripPlan (exact enumeration ≤7 stores, greedy fallback)
        ├── trip-plan-cache (LRU, 5 entries, 5-min TTL)
        └── TripPlanSheet (bottom sheet modal)
```

## Files

### New

| File | Purpose |
|------|---------|
| `src/pricing/trip-plan.ts` | Core algorithm: `computeTripPlan()` |
| `src/pricing/trip-plan-cache.ts` | In-memory LRU cache (5 entries, 5-min TTL) |
| `src/components/TripPlanSheet.tsx` | Bottom sheet displaying trip plan |
| `src/components/MaxStopsStepper.tsx` | −/1/2/3/4/5/+ stepper |

### Modified

| File | Change |
|------|--------|
| `src/components/StopOptimizer.tsx` | Added stepper, "Plan My Trip" button, TripPlanSheet |
| `src/screens/GroceryListScreen.tsx` | Passes `fullItems` prop to StopOptimizer |
| `src/pricing/price-store.ts` | Added `tripPlan`, `maxStops`, `setMaxStops`, `precomputeTripPlan` |

## Algorithm

### Exact Enumeration (≤7 stores)

1. Generate all subsets of available stores up to size `maxStops` (max 128 subsets for 7 stores)
2. For each subset, assign each item to the cheapest store in that subset
3. Pick the subset with the lowest total cost

### Greedy Fallback (>7 stores)

1. Start with the single cheapest store
2. Greedily add the store that most reduces total cost
3. Stop when no further improvement or `maxStops` reached

### Complexity

- ≤7 stores: O(2^n × items × stores) — effectively <1ms for typical lists
- >7 stores: O(maxStops × stores × items)

## Cache

- **Key:** `JSON.stringify({ maxStops, itemIds: sorted, storeIds: sorted })`
- **Capacity:** 5 entries (LRU eviction)
- **TTL:** 5 minutes
- **Invalidation:** `invalidateCache()` clears all entries

## Privacy

- All computation is purely on-device (no network calls)
- No data leaves the device
- Respects existing `pricingOptedIn` / `priceServiceEnabled` flags
