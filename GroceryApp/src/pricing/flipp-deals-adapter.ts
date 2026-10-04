/**
 * FlippDealsAdapter — PriceAdapter that queries flipp_deals from Turso.
 *
 * Registered in the price registry so Flipp flyer deals appear as store prices
 * in the shopping list's StopOptimizer UI.
 *
 * How it works:
 *   - Stores the user's FSA (first 3 chars of postal code) in a module variable
 *   - On getPrice/getPrices, fetches all current deals for that FSA
 *   - Matches item names to deal names using keyword token intersection
 *   - Returns PriceResult with merchant as the store
 *
 * The user must configure their FSA in Settings for this adapter to activate.
 * Merchant names from flipp_deals (e.g. "No Frills") are normalized to
 * kebab-case store IDs (e.g. "no-frills") for compatibility with the app.
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult, ConfidenceLevel } from './types';
import { fetchDealsForFSA } from '../services/dealMatcher';
import { getSettings } from '../config/settings';
import type { FlippDealRow } from '../services/dealMatcher';
import { localDate } from './offer-evidence';

// ─── State ──────────────────────────────────────────────────────────────────

/** Cached deals keyed by merchant name */
let _merchantDealsCache: Record<string, FlippDealRow[]> | null = null;
let _cachedFsa: string | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalize a merchant name to kebab-case for storeId comparison */
function merchantToStoreId(merchant: string): string {
  return merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extract meaningful keywords from a product name */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'without', 'fresh', 'frozen', 'organic', 'natural', 'premium',
  'value', 'selected', 'choice', 'best', 'plus', 'all', 'each', 'per',
  'pack', 'bag', 'box', 'bottle', 'can', 'jar', 'tub', 'tray', 'bunch',
  'kg', 'g', 'ml', 'l', 'oz', 'lb', 'litre', 'liter', 'gram', 'grams',
  'piece', 'pieces', 'count', 'size', 'large', 'medium', 'small',
  'grade', 'type', 'style', 'brand', 'save', 'caisse', 'chaque',
]);

function extractKeywords(name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/** Score how well query tokens match deal name tokens (0..1) */
function matchScore(queryTokens: string[], dealTokens: string[]): number {
  if (queryTokens.length === 0 || dealTokens.length === 0) return 0;
  let hits = 0;
  for (const qt of queryTokens) {
    for (const dt of dealTokens) {
      if (qt === dt || dt.includes(qt) || qt.includes(dt)) {
        hits++;
        break;
      }
    }
  }
  if (hits < 2 && queryTokens.length > 1) return 0;
  return hits / queryTokens.length;
}

/** Build merchant-keyed deal cache for the user's FSA */
async function ensureDealsLoaded(fsa: string): Promise<Record<string, FlippDealRow[]>> {
  if (_cachedFsa === fsa && _merchantDealsCache) {
    return _merchantDealsCache;
  }

  const allDeals = await fetchDealsForFSA(fsa, true); // force refresh
  const byMerchant: Record<string, FlippDealRow[]> = {};

  for (const deal of allDeals) {
    const key = merchantToStoreId(deal.merchant);
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(deal);
  }

  _merchantDealsCache = byMerchant;
  _cachedFsa = fsa;
  return byMerchant;
}

/** Find best deal match for an item name from a list of deals */
function findBestDeal(
  itemName: string,
  deals: FlippDealRow[],
  threshold = 0.35,
): { deal: FlippDealRow; score: number } | null {
  const queryTokens = extractKeywords(itemName);
  if (queryTokens.length === 0) return null;

  let best: { deal: FlippDealRow; score: number } | null = null;

  for (const deal of deals) {
    const dealTokens = extractKeywords(deal.name);
    const score = matchScore(queryTokens, dealTokens);
    if (score >= threshold && (!best || score > best.score || (score === best.score && (deal.price_real ?? Infinity) < (best.deal.price_real ?? Infinity)))) {
      best = { deal, score };
    }
  }

  return best;
}

/** Get confidence based on how far in the future the deal expires */
function dealConfidence(validTo: string): ConfidenceLevel {
  if (!validTo) return 'estimated';
  const now = Date.now();
  const end = new Date(validTo).getTime();
  if (isNaN(end)) return 'estimated';
  const remainingDays = (end - now) / (24 * 60 * 60 * 1000);
  if (remainingDays > 7) return 'real_time';
  if (remainingDays > 3) return 'recent';
  if (remainingDays > 1) return 'estimated';
  return 'stale';
}


/**
 * A deal as an offer. The flyer's end date becomes validTo (store-local
 * date) so the planner judges it against the shopping window; the fetch time
 * is the observation time. The old mapping put valid_to into `timestamp`,
 * which made an expiring deal look freshly observed.
 */
function dealToOffer(deal: FlippDealRow, storeId: string, adapterId: string): PriceResult | null {
  const price = deal.price_real ?? parseFloat(deal.price);
  if (price === null || isNaN(price)) return null;
  const end = Date.parse(deal.valid_to);
  return {
    price,
    unitPrice: price,
    unit: 'each',
    saleInfo: null,
    source: {
      adapterId,
      tier: 'flyer',
      storeId,
      storeName: deal.merchant,
    },
    timestamp: Date.now(),
    confidence: dealConfidence(deal.valid_to),
    imageUrl: deal.image_url ?? undefined,
    evidence: {
      provenance: 'flyer',
      sourceLabel: 'Flipp flyer (not checked at your branch)',
      productName: deal.name,
      isSale: true,
      validTo: isNaN(end) ? undefined : localDate(end),
      observedAt: Date.now(),
    },
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class FlippDealsAdapter implements PriceAdapter {
  id = 'flipp-deals';
  name = 'Flipp Flyer Deals';
  tier = 'flyer' as const;

  isAvailable(): boolean {
    const settings = getSettings();
    // The Turso credential path was removed for v1 (Option B — see
    // GOAL_PROMPT_NOTES.md): availability now depends only on the flyer-scan
    // opt-in. With Turso never initialized, fetchDealsForFSA() returns [] and
    // this adapter yields no results — the crowd-sourced fallback still works.
    return !!settings.flyerScanEnabled;
  }

  /**
   * Get the user-configured FSA from settings.
   * Stored in a custom field or derived from their postal code.
   */
  private getUserFsa(): string | null {
    const settings = getSettings() as any;
    return settings.flippFsa ?? 'L0R';
  }

  async getPrice(
    itemName: string,
    storeId: string,
  ): Promise<PriceResult | null> {
    const fsa = this.getUserFsa();
    if (!fsa) return null;

    const byMerchant = await ensureDealsLoaded(fsa);
    const deals = byMerchant[storeId];
    if (!deals || deals.length === 0) return null;

    const match = findBestDeal(itemName, deals);
    if (!match) return null;
    return dealToOffer(match.deal, storeId, this.id);
  }

  async getPrices(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    const fsa = this.getUserFsa();
    if (!fsa) return results;

    const byMerchant = await ensureDealsLoaded(fsa);
    const deals = byMerchant[storeId];
    if (!deals || deals.length === 0) return results;

    for (const itemName of items) {
      const match = findBestDeal(itemName, deals);
      if (!match) continue;
      const offer = dealToOffer(match.deal, storeId, this.id);
      if (offer) results.set(itemName, offer);
    }

    return results;
  }

  /** Get list of stores available for the user's FSA from flipp_deals */
  async getAvailableStores(): Promise<{ storeId: string; storeName: string }[]> {
    const fsa = this.getUserFsa();
    if (!fsa) return [];

    try {
      const allDeals = await fetchDealsForFSA(fsa, false);
      const seen = new Set<string>();
      const stores: { storeId: string; storeName: string }[] = [];
      for (const deal of allDeals) {
        const sid = merchantToStoreId(deal.merchant);
        if (!seen.has(sid)) {
          seen.add(sid);
          stores.push({ storeId: sid, storeName: deal.merchant });
        }
      }
      return stores.sort((a, b) => a.storeName.localeCompare(b.storeName));
    } catch {
      return [];
    }
  }

  /** Allow refreshing the deal cache (e.g., when FSA changes) */
  clearCache(): void {
    _merchantDealsCache = null;
    _cachedFsa = null;
  }
}

export const flippDealsAdapter = new FlippDealsAdapter();
