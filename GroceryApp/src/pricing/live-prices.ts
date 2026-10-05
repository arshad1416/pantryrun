/**
 * Live prices — the operator's scraper data, served by the relay.
 *
 *   flippscrape.py        → Turso flipp_deals   → GET /api/prices/deals?fsa=
 *   store_prices_scrape.py → Turso store_prices → GET /api/prices/shelf?fsa=
 *
 * The app never talks to Turso (GOAL_PROMPT_NOTES "Option B"); the relay
 * reads it with its own read-only token. Requests name a region (FSA), never
 * an item: the whole region's offers come down and the list is matched on
 * the device.
 *
 * This module owns fetching, the per-region snapshot (kept as last-known
 * when a refresh fails, and marked so), and the honest mapping of scraper
 * rows into PriceResult:
 *
 *  - Flyer deals are sales (offerType 'sale') with the flyer's own window.
 *    A date-only end stays a date (validThroughDate) — no time is invented.
 *  - Shelf prices are scraped (tier 'scraping'), so eligibility.ts treats
 *    them as usable but never "verified". Branch, channel and stock are not
 *    claimed.
 *  - Package size is read from the product name ("Milk 4 L"); a multipack
 *    ("12 x 355 mL") or no size leaves the offer per-package-of-one rather
 *    than guessing contents.
 */

import type { PriceResult, SaleInfo, ConfidenceLevel } from './types';
import { parseUnit } from './quantity';
import { DEFAULT_TIME_ZONE, localDate } from './eligibility';
import { extractKeywords, matchScore } from './intent';
import { relayGetJson, RelayRequestError } from './relay-client';

// ─── Row shapes (the relay's allowlisted columns) ───────────────────────────

export interface FlyerDealRow {
  merchant: string;
  name: string;
  price: string;
  price_real: number | null;
  image_url: string | null;
  valid_from?: string | null;
  valid_to: string;
}

export interface ShelfPriceRow {
  store_id: string;
  store_name: string;
  name: string;
  name_clean?: string | null;
  price: string;
  price_real: number | null;
  unit_price?: string | null;
  unit_price_real?: number | null;
  unit?: string | null;
  image_url?: string | null;
  brand?: string | null;
  category?: string | null;
  is_on_sale?: number | null;
  sale_price?: number | null;
  was_price?: number | null;
  scraped_at: string;
}

interface PricesPayload<T> {
  kind: 'deals' | 'shelf';
  fsa: string;
  fetchedAt: string;
  truncated?: boolean;
  /** The relay couldn't reach Turso and served its last good answer. */
  stale?: boolean;
  rows: T[];
}

export interface Snapshot<T> {
  fsa: string;
  rows: T[];
  /** When the relay read these rows (epoch ms) */
  fetchedAt: number;
  /** When this device last loaded them (epoch ms) */
  loadedAt: number;
  /** Set when the latest refresh failed — rows are last-known */
  refreshFailedAt?: number;
}

// ─── Snapshots & status ─────────────────────────────────────────────────────

/** How long a loaded region is reused before asking the relay again. */
export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_FSA = 'L0R';

export type LivePriceState = 'idle' | 'ok' | 'failed' | 'not_configured';
export interface LivePriceStatus {
  state: LivePriceState;
  /** When the failure happened, for 'failed' */
  failedAt?: number;
  /** Why, in words safe to show */
  detail?: string;
}

type Kind = 'deals' | 'shelf';
const snapshots: { deals: Snapshot<FlyerDealRow> | null; shelf: Snapshot<ShelfPriceRow> | null } = {
  deals: null,
  shelf: null,
};
const inflight: Partial<Record<Kind, Promise<unknown>>> = {};
let status: LivePriceStatus = { state: 'idle' };

export function getLivePriceStatus(): LivePriceStatus {
  return status;
}

/** Normalise a user-entered postal code or FSA to the 3-character FSA. */
export function normalizeFsa(input: string | undefined | null): string {
  const fsa = (input ?? '').replace(/\s+/g, '').slice(0, 3).toUpperCase();
  return /^[A-Z]\d[A-Z]$/.test(fsa) ? fsa : DEFAULT_FSA;
}

async function load<T>(kind: Kind, fsa: string, force: boolean): Promise<Snapshot<T> | null> {
  const current = snapshots[kind] as Snapshot<T> | null;
  const now = Date.now();
  if (!force && current && current.fsa === fsa && now - current.loadedAt < REFRESH_INTERVAL_MS) {
    return current;
  }
  const pending = inflight[kind];
  if (pending) return pending as Promise<Snapshot<T> | null>;

  const run = (async () => {
    try {
      const payload = await relayGetJson<PricesPayload<T>>(`/api/prices/${kind}?fsa=${encodeURIComponent(fsa)}`);
      const fetchedAt = Date.parse(payload.fetchedAt);
      const snap: Snapshot<T> = {
        fsa,
        rows: Array.isArray(payload.rows) ? payload.rows : [],
        fetchedAt: Number.isNaN(fetchedAt) ? now : fetchedAt,
        loadedAt: now,
        ...(payload.stale ? { refreshFailedAt: now } : {}),
      };
      (snapshots as Record<Kind, Snapshot<unknown> | null>)[kind] = snap;
      status = payload.stale
        ? { state: 'failed', failedAt: now, detail: 'The price source is unavailable; showing last known prices.' }
        : { state: 'ok' };
      return snap;
    } catch (err) {
      const notConfigured =
        err instanceof RelayRequestError &&
        (err.status === 503 || err.message === 'Relay not configured' || err.message === 'Device not enrolled with the relay');
      status = notConfigured
        ? { state: 'not_configured', detail: err.message === 'Relay not configured' ? 'No relay set up.' : 'Live prices are not set up on the relay.' }
        : { state: 'failed', failedAt: now, detail: 'Live prices unavailable — showing last known.' };
      if (current && current.fsa === fsa) {
        const kept = { ...current, refreshFailedAt: now };
        (snapshots as Record<Kind, Snapshot<unknown> | null>)[kind] = kept;
        return kept;
      }
      return null;
    } finally {
      delete inflight[kind];
    }
  })();
  inflight[kind] = run;
  return run;
}

export function loadFlyerDeals(fsa: string, force = false): Promise<Snapshot<FlyerDealRow> | null> {
  return load<FlyerDealRow>('deals', normalizeFsa(fsa), force);
}

export function loadShelfPrices(fsa: string, force = false): Promise<Snapshot<ShelfPriceRow> | null> {
  return load<ShelfPriceRow>('shelf', normalizeFsa(fsa), force);
}

/** Re-fetch both feeds from the relay now (the "Refresh Prices" button). */
export async function refreshLivePrices(fsa: string | undefined | null): Promise<void> {
  await Promise.all([loadFlyerDeals(fsa ?? '', true), loadShelfPrices(fsa ?? '', true)]);
}

/** Test hook. */
export function _resetLivePrices(): void {
  snapshots.deals = null;
  snapshots.shelf = null;
  status = { state: 'idle' };
}

// ─── Store IDs ──────────────────────────────────────────────────────────────

/** "No Frills" → "no-frills" — the app's store ID for a merchant name. */
export function storeIdFromName(name: string): string {
  return name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Scraper store IDs that don't match their display name's kebab form. */
const SCRAPER_STORE_IDS: Record<string, string> = {
  nofrills: 'no-frills',
  foodbasics: 'food-basics',
  superstore: 'real-canadian-superstore',
};

export function shelfStoreId(row: Pick<ShelfPriceRow, 'store_id' | 'store_name'>): string {
  if (row.store_name) return storeIdFromName(row.store_name);
  return SCRAPER_STORE_IDS[row.store_id] ?? storeIdFromName(row.store_id);
}

// ─── Package size from a product name ───────────────────────────────────────

/**
 * "Neilson 2% Milk 4 L" → { packageSize: 4, unit: 'L' }. A multipack
 * ("12 x 355 mL", "6 × 1 L") or no size → null: the offer is one package
 * of unknown content, which quantity.ts only costs for package-count items.
 */
export function packageFromName(name: string): { packageSize: number; unit: string } | null {
  if (/\d\s*[x×]\s*\d/i.test(name)) return null;
  const matches = [...name.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|lb|lbs|oz)\b/gi)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const size = parseFloat(last[1].replace(',', '.'));
  const unit = last[2].toLowerCase() === 'l' ? 'L' : last[2].toLowerCase();
  if (!(size > 0) || !parseUnit(unit)) return null;
  return { packageSize: size, unit };
}

// ─── Dates ──────────────────────────────────────────────────────────────────

/** A date-only value stays a date; anything with a time becomes an instant. */
function offerBoundary(value: string | null | undefined): { date?: string; instant?: number } {
  if (!value) return {};
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { date: trimmed };
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? {} : { instant: ms };
}

/**
 * Has this flyer offer already ended? Matching skips ended offers so an
 * expired cheaper deal can't shadow a current one for the same product.
 * (Whether a current offer covers the whole shopping window is
 * eligibility.ts's call.)
 */
export function flyerOfferEnded(row: Pick<FlyerDealRow, 'valid_to'>, now: number = Date.now()): boolean {
  const end = offerBoundary(row.valid_to);
  if (end.instant !== undefined) return end.instant < now;
  if (end.date) return end.date < localDate(now, DEFAULT_TIME_ZONE);
  return false;
}

/** SQLite datetime('now') text is UTC without a zone marker. */
function parseScrapedAt(value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(iso);
}

function confidenceForAge(ageMs: number): ConfidenceLevel {
  const days = ageMs / (24 * 60 * 60 * 1000);
  if (days < 1) return 'real_time';
  if (days < 3) return 'recent';
  if (days < 7) return 'estimated';
  return 'stale';
}

// ─── Row → PriceResult ──────────────────────────────────────────────────────

/** "2/$5", "2 for $5.00" → per-item 2.50 with the group terms */
function parseMultiBuy(price: string): { groupSize: number; groupPrice: number } | null {
  const m = price.match(/^\s*(\d+)\s*(?:\/|for)\s*\$?\s*(\d+(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const groupSize = parseInt(m[1], 10);
  const groupPrice = parseFloat(m[2]);
  return groupSize >= 2 && groupPrice > 0 ? { groupSize, groupPrice } : null;
}

/** "$3.99/lb", "1.49 /kg" → the weighed unit */
function perMeasureUnit(price: string): string | null {
  const m = price.match(/\/\s*(kg|lb|100\s*g)\b/i);
  if (!m) return null;
  const u = m[1].toLowerCase().replace(/\s+/g, '');
  return u === '100g' ? null : u; // per-100g is a unit price, not a sellable rate
}

export function flyerDealToPriceResult(row: FlyerDealRow, snap: Snapshot<FlyerDealRow>): PriceResult | null {
  const multiBuy = parseMultiBuy(row.price ?? '');
  const price = multiBuy ? multiBuy.groupPrice / multiBuy.groupSize : row.price_real ?? parseFloat(row.price);
  if (!(typeof price === 'number' && price > 0)) return null;

  const from = offerBoundary(row.valid_from);
  const to = offerBoundary(row.valid_to);
  const measure = perMeasureUnit(row.price ?? '');
  const pkg = measure ? null : packageFromName(row.name);

  return {
    price,
    unitPrice: price,
    unit: measure ?? pkg?.unit ?? 'each',
    saleInfo: null,
    source: {
      adapterId: 'flipp-deals',
      tier: 'flyer',
      storeId: storeIdFromName(row.merchant),
      storeName: row.merchant,
    },
    timestamp: snap.fetchedAt,
    confidence: 'recent',
    ...(row.image_url ? { imageUrl: row.image_url } : {}),
    matchedName: row.name,
    offerType: 'sale',
    ...(measure ? { pricingBasis: 'measure' as const } : {}),
    ...(pkg ? { packageSize: pkg.packageSize, pricingBasis: 'package' as const } : {}),
    ...(multiBuy ? { multiBuy: { ...multiBuy, requiresFullGroup: false } } : {}),
    ...(from.date ? { validFromDate: from.date } : {}),
    ...(from.instant !== undefined ? { validFrom: from.instant } : {}),
    ...(to.date ? { validThroughDate: to.date } : {}),
    ...(to.instant !== undefined ? { validTo: to.instant } : {}),
    ...(snap.refreshFailedAt ? { refreshFailedAt: snap.refreshFailedAt } : {}),
  };
}

export function shelfPriceToPriceResult(
  row: ShelfPriceRow,
  snap: Snapshot<ShelfPriceRow>,
  now: number = Date.now(),
): PriceResult | null {
  const regular = row.price_real ?? parseFloat(row.price);
  const onSale = row.is_on_sale === 1 && typeof row.sale_price === 'number' && row.sale_price > 0;
  const price = onSale ? (row.sale_price as number) : regular;
  if (!(typeof price === 'number' && price > 0)) return null;

  const scrapedAt = parseScrapedAt(row.scraped_at);
  if (Number.isNaN(scrapedAt)) return null;
  const confidence = confidenceForAge(now - scrapedAt);
  if (confidence === 'stale') return null;

  const wasPrice = onSale ? row.was_price ?? (regular > price ? regular : null) : null;
  let saleInfo: SaleInfo | null = null;
  if (onSale && wasPrice && wasPrice > price) {
    saleInfo = {
      isOnSale: true,
      salePrice: price,
      regularPrice: wasPrice,
      saleEndDate: null,
      unitPriceVsRegular: price - wasPrice,
      savingsPercent: Math.round(((wasPrice - price) / wasPrice) * 100),
    };
  }

  // Package from the name; otherwise a per-kg / per-lb shelf rate, when the
  // scraper says so; otherwise one package of unknown content.
  const pkg = packageFromName(row.name);
  const scrapedUnit = (row.unit ?? '').trim().toLowerCase();
  const weighed = !pkg && (scrapedUnit === 'kg' || scrapedUnit === 'lb') && typeof row.unit_price_real === 'number' && row.unit_price_real > 0;

  return {
    price: weighed ? (row.unit_price_real as number) : price,
    unitPrice: row.unit_price_real ?? price,
    unit: weighed ? scrapedUnit : pkg?.unit ?? 'each',
    saleInfo,
    source: {
      adapterId: 'store-prices',
      tier: 'scraping',
      storeId: shelfStoreId(row),
      storeName: row.store_name || row.store_id,
    },
    timestamp: scrapedAt,
    confidence,
    ...(row.image_url ? { imageUrl: row.image_url } : {}),
    matchedName: row.name,
    offerType: onSale ? 'sale' : 'regular',
    ...(weighed ? { pricingBasis: 'measure' as const } : {}),
    ...(pkg ? { packageSize: pkg.packageSize, pricingBasis: 'package' as const } : {}),
    ...(snap.refreshFailedAt ? { refreshFailedAt: snap.refreshFailedAt } : {}),
  };
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** Minimum share of the item's words a product name must contain. */
const MATCH_THRESHOLD = 0.35;

/**
 * The row whose name best matches `itemName` (whole-word tokens), cheapest
 * on a tie. Variant and "sale only" checks happen later, in eligibility.ts,
 * against the returned PriceResult's matchedName.
 */
export function findBestRow<T>(
  itemName: string,
  rows: T[],
  nameOf: (row: T) => string,
  priceOf: (row: T) => number | null,
): T | null {
  const query = extractKeywords(itemName);
  if (query.length === 0) return null;
  let best: { row: T; score: number } | null = null;
  for (const row of rows) {
    const score = matchScore(query, extractKeywords(nameOf(row)));
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && (priceOf(row) ?? Infinity) < (priceOf(best.row) ?? Infinity))) {
      best = { row, score };
    }
  }
  return best?.row ?? null;
}
