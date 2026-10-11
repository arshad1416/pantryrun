/**
 * Price Subsystem — Flyer Scan Adapter.
 *
 * Implements the PriceAdapter interface for flyer-scanned prices.
 * Follows the same pattern as CrowdsourcedAdapter but with
 * flyer-specific storage, confidence scoring, and sale detection.
 *
 * Design:
 *  - Scanned records are kept per store; the singleton persists them on the
 *    device, encrypted at rest (local-price-records.ts), so a scan survives
 *    a restart
 *  - submitScannedPrices() to persist scanned flyer data
 *  - Items are matched to scanned product names with the same relevance
 *    matcher as the live feeds (live-prices.ts findCandidateRows), so
 *    "milk" finds "Neilson 2% Milk 4 L" but never "Coconut Milk"
 *  - getPrice/getPrices return the best (newest on a tie) non-expired match;
 *    getCandidates returns the ranked list for the basket to pick from
 *  - The scanned quantity/unit becomes the offer's package size
 *  - Uses normalizeUnitPrice() for unit price computation
 *
 * Critical rules:
 *  - Additive only — don't modify existing adapter logic
 *  - EXIF stripped before any processing (handled by pipeline, not adapter)
 *  - Image discarded after extraction (handled by pipeline, not adapter)
 */

import type { PriceAdapter } from './adapter';
import type { PriceResult, PriceSourceTier, ConfidenceLevel } from './types';
import type { ScannedFlyerPrice } from './flyer-types';
import { normalizeUnitPrice } from './normalizer';
import { parseUnit } from './quantity';
import { findCandidateRows, packageFromName, UNKNOWN_PACKAGE_UNIT } from './live-prices';
import { clearLocalPriceRecords, LOCAL_PRICE_ALIASES, loadLocalPriceRecords, saveLocalPriceRecords } from './local-price-records';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Scans older than this (or long expired) are not kept on disk. */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;
/** Most scanned records kept on disk (newest win). */
const MAX_STORED = 1000;

function getConfidenceLevel(
  modelConfidence: number,
): ConfidenceLevel {
  if (modelConfidence >= 0.9) return 'real_time';
  if (modelConfidence >= 0.75) return 'recent';
  if (modelConfidence >= 0.6) return 'estimated';
  return 'estimated';
}

/**
 * What one scanned price buys:
 *  - a mass/volume quantity ("2 L", "400 g") is the package content —
 *    except a lone "1 kg"/"1 lb", which flyers use for a per-weight rate;
 *  - a count above one ("6 each") is a pack of that many;
 *  - otherwise the size in the product name, or one package of unknown content.
 */
function offerTerms(record: ScannedFlyerPrice): Pick<PriceResult, 'unit' | 'packageSize' | 'pricingBasis'> {
  const unit = parseUnit(record.unit);
  const qty = record.quantity > 0 ? record.quantity : 1;
  const u = (record.unit ?? '').trim().toLowerCase();
  if (unit && unit[0] !== 'count') {
    if (qty === 1 && (u === 'kg' || u === 'lb' || u === 'lbs')) return { unit: u, pricingBasis: 'measure' };
    return { unit: record.unit, packageSize: qty, pricingBasis: 'package' };
  }
  if (unit && qty > 1) return { unit: 'each', packageSize: qty * unit[1], pricingBasis: 'package' };
  const fromName = packageFromName(record.itemName);
  if (fromName) return { unit: fromName.unit, packageSize: fromName.packageSize, pricingBasis: 'package' };
  return { unit: UNKNOWN_PACKAGE_UNIT, pricingBasis: 'package' };
}

export interface FlyerScanOptions {
  /** Persist scanned prices on the device (the app's singleton does). */
  persist?: boolean;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class FlyerScanAdapter implements PriceAdapter {
  id = 'flyer-scan';
  name = 'Flyer Scan';
  tier: PriceSourceTier = 'flyer';

  /** All scanned records, kept for price history; matching picks the newest valid. */
  private records: ScannedFlyerPrice[] = [];
  private readonly persist: boolean;
  private hydration: Promise<void> | null = null;

  constructor(options: FlyerScanOptions = {}) {
    this.persist = options.persist ?? false;
  }

  isAvailable(): boolean {
    return true; // always available locally
  }

  private ensureLoaded(): Promise<void> {
    if (!this.persist) return Promise.resolve();
    if (!this.hydration) {
      this.hydration = loadLocalPriceRecords<ScannedFlyerPrice>(LOCAL_PRICE_ALIASES.flyerScan).then((stored) => {
        const valid = stored.filter(
          (r) => r && typeof r.itemName === 'string' && typeof r.storeId === 'string' && typeof r.price === 'number',
        );
        this.records = [...valid, ...this.records];
      });
    }
    return this.hydration;
  }

  private storedRecords(now: number = Date.now()): ScannedFlyerPrice[] {
    return this.records
      .filter((r) => r.scannedAt >= now - RETAIN_MS && (r.validTo === null || r.validTo >= now - RETAIN_MS))
      .sort((a, b) => a.scannedAt - b.scannedAt)
      .slice(-MAX_STORED);
  }

  /**
   * Submit scanned flyer prices to the internal store.
   * Multiple prices for the same item are kept for price history.
   *
   * @param records - Array of ScannedFlyerPrice entries from the pipeline
   */
  async submitScannedPrices(records: ScannedFlyerPrice[]): Promise<void> {
    await this.ensureLoaded();
    this.records.push(...records);
    if (this.persist) await saveLocalPriceRecords(LOCAL_PRICE_ALIASES.flyerScan, this.storedRecords());
  }

  private toPriceResult(record: ScannedFlyerPrice): PriceResult {
    const { unitPrice } = normalizeUnitPrice(record.price, record.quantity, record.unit);
    return {
      price: record.price,
      unitPrice,
      // If the price was on sale in the flyer, pass through the sale info
      saleInfo: record.saleInfo ?? null,
      source: {
        adapterId: this.id,
        tier: this.tier,
        storeId: record.storeId,
        storeName: record.storeName,
      },
      timestamp: record.scannedAt,
      confidence: getConfidenceLevel(record.confidence),
      matchedName: record.itemName,
      ...offerTerms(record),
      ...(record.validTo !== null ? { validTo: record.validTo } : {}),
    };
  }

  /**
   * Ranked non-expired matches per item at a store (best first, newest scan
   * on a tie).
   */
  async getCandidates(items: string[], storeId: string): Promise<Map<string, PriceResult[]>> {
    await this.ensureLoaded();
    const now = Date.now();
    const valid = this.records.filter(
      (r) => r.storeId === storeId && (r.validTo === null || r.validTo > now),
    );
    const results = new Map<string, PriceResult[]>();
    if (valid.length === 0) return results;
    for (const item of items) {
      const rows = findCandidateRows(item, valid, (r) => r.itemName, (r) => r.price, (r) => r.scannedAt);
      if (rows.length > 0) results.set(item, rows.map((r) => this.toPriceResult(r)));
    }
    return results;
  }

  /**
   * Get the best valid price for an item at a given store.
   * Returns null if no valid (non-expired) price exists.
   */
  async getPrice(
    itemName: string,
    storeId: string,
  ): Promise<PriceResult | null> {
    return (await this.getCandidates([itemName], storeId)).get(itemName)?.[0] ?? null;
  }

  /**
   * Get prices for multiple items at a given store.
   */
  async getPrices(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    for (const [item, list] of await this.getCandidates(items, storeId)) results.set(item, list[0]);
    return results;
  }

  /**
   * Clear all stored flyer prices (for testing / user request).
   */
  clearAllPrices(): void {
    this.records = [];
    this.hydration = Promise.resolve();
    if (this.persist) void clearLocalPriceRecords([LOCAL_PRICE_ALIASES.flyerScan]).catch(() => {});
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const flyerScanAdapter = new FlyerScanAdapter({ persist: true });
