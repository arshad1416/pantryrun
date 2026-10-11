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
 *  - Package size is read from the product name ("Milk 4 L", "6 x 355 mL",
 *    "12 Pack"); with no size the offer is one package of unknown content
 *    (unit 'pkg'), never a per-each price.
 */

import type { PriceResult, SaleInfo, ConfidenceLevel } from './types';
import { parseUnit } from './quantity';
import { DEFAULT_TIME_ZONE, localDate } from './eligibility';
import { extractKeywords, HARD_ATTRIBUTES, matchScore } from './intent';
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
  /** The relay hit its row cap: some offers in the region are missing. */
  truncated?: boolean;
}

// ─── Snapshots & status ─────────────────────────────────────────────────────

/** How long a loaded region is reused before asking the relay again. */
export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** Shown in the live-price banner when the user hasn't set a region. */
export const REGION_MISSING_DETAIL =
  'Set your postal code (FSA) in Settings → Flipp Deal Matching to see live prices near you.';

export type LivePriceState = 'idle' | 'ok' | 'failed' | 'not_configured';
export interface LivePriceStatus {
  state: LivePriceState;
  /** When the failure happened, for 'failed' */
  failedAt?: number;
  /** Why, in words safe to show */
  detail?: string;
  /** Machine-readable cause: no region set, so nothing was fetched. */
  reason?: 'region_missing';
  /** The last answer was cut at the relay's row cap (partial coverage). */
  truncated?: boolean;
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

/**
 * Normalise a user-entered postal code or FSA to the 3-character FSA, or
 * null when there isn't a valid one. No region is ever assumed: prices from
 * somewhere else are worse than none.
 */
export function normalizeFsa(input: string | undefined | null): string | null {
  const fsa = (input ?? '').replace(/\s+/g, '').slice(0, 3).toUpperCase();
  return /^[A-Z]\d[A-Z]$/.test(fsa) ? fsa : null;
}

/** No region set: fetch nothing and ask for a postal code in the price banner. */
function regionMissing(): null {
  status = { state: 'failed', reason: 'region_missing', detail: REGION_MISSING_DETAIL };
  return null;
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
        ...(payload.truncated ? { truncated: true } : {}),
      };
      (snapshots as Record<Kind, Snapshot<unknown> | null>)[kind] = snap;
      status = payload.stale
        ? { state: 'failed', failedAt: now, detail: 'The price source is unavailable; showing last known prices.' }
        : snapshots.deals?.truncated || snapshots.shelf?.truncated
          ? { state: 'ok', truncated: true, detail: 'Showing partial prices: some stores in your area were cut off.' }
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

export function loadFlyerDeals(fsa: string | undefined | null, force = false): Promise<Snapshot<FlyerDealRow> | null> {
  const region = normalizeFsa(fsa);
  return region ? load<FlyerDealRow>('deals', region, force) : Promise.resolve(regionMissing());
}

export function loadShelfPrices(fsa: string | undefined | null, force = false): Promise<Snapshot<ShelfPriceRow> | null> {
  const region = normalizeFsa(fsa);
  return region ? load<ShelfPriceRow>('shelf', region, force) : Promise.resolve(regionMissing());
}

/** Re-fetch both feeds from the relay now (the "Refresh Prices" button). */
export async function refreshLivePrices(fsa: string | undefined | null): Promise<void> {
  await Promise.all([loadFlyerDeals(fsa, true), loadShelfPrices(fsa, true)]);
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

const MEASURE_UNIT = '(kg|g|ml|l|lb|lbs|oz)';
/** "6 x 355 mL", "4x100g", "12 × 1 L" — a multipack of sized units */
const MULTIPACK_RE = new RegExp(`(\\d+)\\s*[x×]\\s*(\\d+(?:[.,]\\d+)?)\\s*${MEASURE_UNIT}\\b`, 'i');
const SIZE_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${MEASURE_UNIT}\\b`, 'gi');
/** "12 pack", "12-pk", "12 ct", "6 count", "10 pcs", "pack of 12" */
const COUNT_RE = /(\d+)\s*-?\s*(?:pack|pk|pkg|ct|count|pcs?|pieces?)\b|\bpack\s+of\s+(\d+)\b/i;
/** "dozen", "2 dozen", "half dozen", "1/2 dozen" */
const DOZEN_RE = /(?:\b(half|1\/2)\s+(?:a\s+)?|(\d+)\s*)?\bdozen\b/i;

function measureUnit(raw: string): string {
  const u = raw.toLowerCase();
  return u === 'l' ? 'L' : u;
}

function countFromName(name: string): number | null {
  const c = name.match(COUNT_RE);
  if (c) return parseInt(c[1] ?? c[2], 10) || null;
  const d = name.match(DOZEN_RE);
  if (d) return d[1] ? 6 : d[2] ? parseInt(d[2], 10) * 12 || null : 12;
  return null;
}

/**
 * Package contents from a product name:
 *  - "Neilson 2% Milk 4 L"           → 4 L
 *  - "Coca-Cola 6 x 355 mL"          → 2130 mL (multipack: count × size)
 *  - "Burnbrae Large Eggs 12 Pack"   → 12 each; "Eggs Dozen" → 12 each
 *  - "Pepsi 12 pk 355 mL"            → 4260 mL
 * No recognisable size → null: one package of unknown content, which
 * quantity.ts costs only for package-count items ("1 milk"), never per each.
 */
export function packageFromName(name: string): { packageSize: number; unit: string } | null {
  const multi = name.match(MULTIPACK_RE);
  if (multi) {
    const count = parseInt(multi[1], 10);
    const size = parseFloat(multi[2].replace(',', '.'));
    const unit = measureUnit(multi[3]);
    if (count > 0 && size > 0 && parseUnit(unit)) return { packageSize: +(count * size).toFixed(3), unit };
    return null;
  }
  // "2 x 3" with no unit: contents unknown.
  if (/\d\s*[x×]\s*\d/i.test(name)) return null;

  const count = countFromName(name);
  const sizes = [...name.matchAll(SIZE_RE)];
  const last = sizes[sizes.length - 1];
  if (last) {
    const size = parseFloat(last[1].replace(',', '.'));
    const unit = measureUnit(last[2]);
    if (!(size > 0) || !parseUnit(unit)) return null;
    return { packageSize: count && count > 1 ? +(count * size).toFixed(3) : size, unit };
  }
  if (count && count > 0) return { packageSize: count, unit: 'each' };
  return null;
}

/** Unit of an offer whose contents are unknown: one package, never "each". */
export const UNKNOWN_PACKAGE_UNIT = 'pkg';

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
export function parseScrapedAt(value: string): number {
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
    unit: measure ?? pkg?.unit ?? UNKNOWN_PACKAGE_UNIT,
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
    pricingBasis: measure ? 'measure' : 'package',
    ...(pkg ? { packageSize: pkg.packageSize } : {}),
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
    unit: weighed ? scrapedUnit : pkg?.unit ?? UNKNOWN_PACKAGE_UNIT,
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
    pricingBasis: weighed ? 'measure' : 'package',
    ...(pkg ? { packageSize: pkg.packageSize } : {}),
    ...(snap.refreshFailedAt ? { refreshFailedAt: snap.refreshFailedAt } : {}),
  };
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** Minimum share of the item's words a product name must contain. */
const MATCH_THRESHOLD = 0.35;

/** Most candidates an adapter returns per item and store. */
export const MAX_CANDIDATES = 8;

/**
 * Words that turn a product into a different kind of product: a derived
 * form ("apple juice", "potato chips", "tomato sauce"), a different base
 * ("coconut milk", "almond milk"), a confection ("Mini Eggs", "milk
 * chocolate") or a non-food ("lemon dish soap"). A product carrying one the
 * item doesn't ask for is not the item, however many words it shares.
 */
const CATEGORY_CHANGERS = new Set(extractKeywords([
  // derived forms
  'juice', 'sauce', 'paste', 'puree', 'soup', 'broth', 'stock', 'powder', 'syrup',
  'jam', 'jelly', 'spread', 'dip', 'dressing', 'ketchup', 'vinegar', 'cider',
  'chip', 'crisp', 'cracker', 'cookie', 'cake', 'pie', 'muffin', 'pudding', 'bar',
  'cereal', 'snack', 'noodle', 'drink', 'beverage', 'smoothie', 'yogurt', 'cream',
  'nog', 'flavour', 'flavor', 'flavoured', 'flavored', 'scented', 'condensed', 'evaporated',
  // different base
  'coconut', 'almond', 'oat', 'soy', 'cashew', 'peanut',
  // confectionery
  'chocolate', 'choc', 'candy', 'gummy', 'gum', 'mini', 'cadbury',
  // not food
  'soap', 'detergent', 'shampoo', 'candle', 'cleaner', 'cat', 'dog', 'pet', 'treat',
].join(' ')));

/** The item's head noun: its last word that isn't a variant attribute. */
function headNoun(query: string[]): string | undefined {
  return [...query].reverse().find((t) => !HARD_ATTRIBUTES.has(t));
}

/**
 * How well a product name stands for the item, or null when it doesn't:
 *  - coverage: share of the item's words in the product (whole tokens)
 *  - precision: share of the product's words the item asked for — brand and
 *    descriptive extras rank a product lower, never reject it
 * Rejected: below the coverage threshold, missing the item's head noun, or
 * carrying a category-changing word the item doesn't.
 */
export function matchQuality(
  query: string[],
  productName: string,
): { coverage: number; precision: number } | null {
  const product = extractKeywords(productName);
  const coverage = matchScore(query, product);
  if (coverage < MATCH_THRESHOLD) return null;
  const wanted = new Set(query);
  const head = headNoun(query);
  if (head && !product.includes(head)) return null;
  if (product.some((t) => CATEGORY_CHANGERS.has(t) && !wanted.has(t))) return null;
  const words = [...new Set(product.filter((t) => !/^\d+$/.test(t)))];
  const precision = words.length === 0 ? 1 : words.filter((t) => wanted.has(t)).length / words.length;
  return { coverage, precision };
}

/**
 * The rows that best stand for `itemName`, best first (coverage, then
 * precision, then newest, then cheapest), at most MAX_CANDIDATES, one per
 * product name. Variant, sale-only and purchase checks happen later
 * (eligibility.ts / basket.ts) against each PriceResult's matchedName —
 * the basket picks among these, so a cheaper look-alike can't win here.
 */
export function findCandidateRows<T>(
  itemName: string,
  rows: T[],
  nameOf: (row: T) => string,
  priceOf: (row: T) => number | null,
  timeOf: (row: T) => number = () => 0,
): T[] {
  const query = extractKeywords(itemName);
  if (query.length === 0) return [];
  const scored: { row: T; coverage: number; precision: number; time: number; price: number }[] = [];
  for (const row of rows) {
    const q = matchQuality(query, nameOf(row));
    if (!q) continue;
    const time = timeOf(row);
    scored.push({ row, ...q, time: Number.isFinite(time) ? time : 0, price: priceOf(row) ?? Infinity });
  }
  scored.sort((a, b) =>
    b.coverage - a.coverage || b.precision - a.precision || b.time - a.time || a.price - b.price);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of scored) {
    const key = nameOf(s.row).trim().toLowerCase();
    if (seen.has(key)) continue; // same product: the newest listing already won
    seen.add(key);
    out.push(s.row);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** The single best row for `itemName` (see findCandidateRows). */
export function findBestRow<T>(
  itemName: string,
  rows: T[],
  nameOf: (row: T) => string,
  priceOf: (row: T) => number | null,
  timeOf?: (row: T) => number,
): T | null {
  return findCandidateRows(itemName, rows, nameOf, priceOf, timeOf)[0] ?? null;
}

/**
 * Keep only the newest row per key (e.g. store + product): the shelf feed
 * carries up to a week of scrapes, and an older cheaper price must never
 * stand in for the current one.
 */
export function newestPerKey<T>(rows: T[], keyOf: (row: T) => string, timeOf: (row: T) => number): T[] {
  const best = new Map<string, { row: T; time: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const time = timeOf(row);
    const t = Number.isFinite(time) ? time : -Infinity;
    const cur = best.get(key);
    if (!cur || t > cur.time) best.set(key, { row, time: t });
  }
  return [...best.values()].map((v) => v.row);
}
