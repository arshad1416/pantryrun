/**
 * Price Subsystem — Crowd-Sourced Adapter.
 *
 * Full implementation of the PriceAdapter interface using locally submitted
 * prices from family members. Prices are stored in-memory (Map) keyed by
 * normalized item name and store ID.
 *
 * Confidence scoring:
 *   - 0 submissions        → not available
 *   - 1-2 submissions      → estimated
 *   - 3-5 submissions      → recent
 *   - 5+ submissions       → real_time
 */

import type { PriceAdapter } from './adapter';
import type {
  PriceResult,
  PriceSourceTier,
  ConfidenceLevel,
  SubmittedPrice,
} from './types';
import { normalizeUnitPrice } from './normalizer';
import { generateUUID } from '../crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

type StorePriceMap = Map<string, SubmittedPrice[]>;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** `submittedBy` of the built-in sample prices. */
const SEED_SUBMITTER = 'system-seed';

function normalizeItemName(name: string): string {
  return name.toLowerCase().trim();
}

function getConfidenceLevel(count: number): ConfidenceLevel {
  if (count >= 5) return 'real_time';
  if (count >= 3) return 'recent';
  if (count >= 1) return 'estimated';
  return 'estimated';
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class CrowdsourcedAdapter implements PriceAdapter {
  id = 'crowdsourced';
  name = 'Crowd-Sourced';
  tier: PriceSourceTier = 'crowd';

  /**
   * Internal price store: storeId → (normalizedItemName → SubmittedPrice[])
   */
  private prices: Map<string, StorePriceMap> = new Map();

  /** Maximum age of submissions to consider (30 days in ms) */
  private readonly maxAgeMs = 30 * 24 * 60 * 60 * 1000;

  constructor() {
    this.seedDefaultPrices();
  }

  /**
   * Seed default prices for 8 common grocery items across 6 Ontario stores.
   * Called in the constructor so prices are available immediately — no async timing issues.
   */
  private seedDefaultPrices(): void {
    const stores = [
      { id: 'no-frills', name: 'No Frills' },
      { id: 'loblaws', name: 'Loblaws' },
      { id: 'freshco', name: 'FreshCo' },
      { id: 'metro', name: 'Metro' },
      { id: 'walmart', name: 'Walmart' },
      { id: 'food-basics', name: 'Food Basics' },
    ];
    const items = [
      { name: 'Apples', unit: 'pcs', quantity: 6, prices: { 'no-frills': 1.99, 'loblaws': 3.49, 'freshco': 2.29, 'metro': 2.99, 'walmart': 2.49, 'food-basics': 2.09 } },
      { name: 'Bananas', unit: 'bunch', quantity: 1, prices: { 'no-frills': 1.19, 'loblaws': 1.79, 'freshco': 1.25, 'metro': 1.49, 'walmart': 1.29, 'food-basics': 1.15 } },
      { name: 'Milk', unit: 'L', quantity: 1, prices: { 'no-frills': 3.89, 'loblaws': 4.49, 'freshco': 3.95, 'metro': 4.29, 'walmart': 3.99, 'food-basics': 3.79 } },
      { name: 'Tomatoes', unit: 'pcs', quantity: 4, prices: { 'no-frills': 2.49, 'loblaws': 3.99, 'freshco': 2.79, 'metro': 3.29, 'walmart': 2.99, 'food-basics': 2.59 } },
      { name: 'Carrots', unit: 'bag', quantity: 1, prices: { 'no-frills': 1.99, 'loblaws': 2.99, 'freshco': 2.29, 'metro': 2.49, 'walmart': 2.49, 'food-basics': 1.79 } },
      { name: 'Potatoes', unit: 'lb', quantity: 5, prices: { 'no-frills': 2.49, 'loblaws': 4.49, 'freshco': 2.99, 'metro': 3.99, 'walmart': 3.49, 'food-basics': 2.29 } },
      { name: 'Onions', unit: 'pcs', quantity: 3, prices: { 'no-frills': 1.49, 'loblaws': 2.49, 'freshco': 1.79, 'metro': 2.29, 'walmart': 1.99, 'food-basics': 1.59 } },
      { name: 'Avocados', unit: 'pcs', quantity: 2, prices: { 'no-frills': 1.99, 'loblaws': 2.99, 'freshco': 2.29, 'metro': 2.79, 'walmart': 2.49, 'food-basics': 1.89 } },
    ];

    for (const store of stores) {
      for (const item of items) {
        const price = (item.prices as Record<string, number>)[store.id];
        if (price !== undefined) {
          this.addPriceSync({
            itemName: item.name,
            storeId: store.id,
            storeName: store.name,
            price,
            unit: item.unit,
            quantity: item.quantity,
            submittedBy: SEED_SUBMITTER,
          });
        }
      }
    }
  }

  isAvailable(): boolean {
    return true; // always available locally
  }

  /**
   * Submit a price from a user. Automatically generates id and timestamp.
   */
  async submitPrice(
    price: Omit<SubmittedPrice, 'id' | 'timestamp'>,
  ): Promise<void> {
    const id = await generateUUID();
    this.addPriceSync(price, id, Date.now());
  }

  /**
   * Add a price synchronously (for seed data during init).
   * Skips UUID generation — accepts optional id and timestamp.
   */
  addPriceSync(
    price: Omit<SubmittedPrice, 'id' | 'timestamp'>,
    id?: string,
    timestamp?: number,
  ): void {
    const submission: SubmittedPrice = {
      ...price,
      id: id || 'seed-' + Math.random().toString(36).slice(2, 10),
      timestamp: timestamp || Date.now(),
    };

    const storeId = price.storeId;
    const key = normalizeItemName(price.itemName);

    if (!this.prices.has(storeId)) {
      this.prices.set(storeId, new Map());
    }
    const storeMap = this.prices.get(storeId)!;

    if (!storeMap.has(key)) {
      storeMap.set(key, []);
    }
    storeMap.get(key)!.push(submission);
  }

  /**
   * Get price for an item by aggregating submissions from the last 30 days.
   */
  async getPrice(
    itemName: string,
    storeId: string,
  ): Promise<PriceResult | null> {
    const key = normalizeItemName(itemName);
    const storeMap = this.prices.get(storeId);
    if (!storeMap) return null;

    const submissions = storeMap.get(key);
    if (!submissions || submissions.length === 0) return null;

    // Filter to last 30 days
    const cutoff = Date.now() - this.maxAgeMs;
    const recent = submissions.filter((s) => s.timestamp >= cutoff);

    if (recent.length === 0) return null;

    // A price someone logged is an edit: the latest one wins, and sample
    // rows never dilute it (a median of [your $2.49, sample $3.89] used to
    // return the sample).
    const logged = recent.filter((s) => s.submittedBy !== SEED_SUBMITTER);
    if (logged.length > 0) {
      const latest = logged.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
      const norm = normalizeUnitPrice(latest.price, latest.quantity > 0 ? latest.quantity : 1, latest.unit);
      return {
        price: latest.price,
        unitPrice: norm.unitPrice,
        unit: latest.unit,
        displayUnit: norm.displayUnit,
        saleInfo: null,
        source: { adapterId: this.id, tier: this.tier, storeId, storeName: latest.storeName },
        timestamp: latest.timestamp,
        confidence: getConfidenceLevel(logged.length),
        ...(latest.quantity > 0 ? { packageSize: latest.quantity } : {}),
        ...(latest.pricingBasis ? { pricingBasis: latest.pricingBasis } : {}),
      };
    }

    // Use median price (more robust than mean); its quantity is the package it bought
    const byPrice = [...recent].sort((a, b) => a.price - b.price);
    const median = byPrice[Math.floor(byPrice.length / 2)];
    const medianPrice = median.price;

    // Average unit/quantity for normalization
    const avgQuantity =
      recent.reduce((sum, s) => sum + s.quantity, 0) / recent.length;
    const unit = recent[0].unit;

    const { unitPrice, displayUnit } = normalizeUnitPrice(
      medianPrice,
      avgQuantity,
      unit,
    );

    return {
      price: medianPrice,
      unitPrice,
      unit,
      displayUnit,
      saleInfo: null, // crowd-sourced can't detect sales
      source: {
        adapterId: this.id,
        tier: this.tier,
        storeId,
        storeName: recent[0].storeName,
      },
      timestamp: Math.max(...recent.map((s) => s.timestamp)),
      confidence: getConfidenceLevel(recent.length),
      ...(median.quantity > 0 ? { packageSize: median.quantity } : {}),
      // Seeded sample prices are demo data, never an observed shelf price.
      ...(recent.every((s) => s.submittedBy === SEED_SUBMITTER) ? { isDemo: true } : {}),
    };
  }

  /**
   * Get prices for multiple items.
   */
  async getPrices(
    items: string[],
    storeId: string,
  ): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    for (const item of items) {
      const price = await this.getPrice(item, storeId);
      if (price) {
        results.set(item, price);
      }
    }
    return results;
  }

  /**
   * Get price history for an item.
   */
  async getPriceHistory(
    itemName: string,
    storeId: string,
    days: number,
  ): Promise<PriceResult[]> {
    const key = normalizeItemName(itemName);
    const storeMap = this.prices.get(storeId);
    if (!storeMap) return [];

    const submissions = storeMap.get(key);
    if (!submissions) return [];

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = submissions.filter((s) => s.timestamp >= cutoff);
    const unit = recent.length > 0 ? recent[0].unit : 'each';

    return recent.map((s) => {
      const { unitPrice, displayUnit } = normalizeUnitPrice(s.price, s.quantity, unit);
      return {
        price: s.price,
        unitPrice,
        unit,
        displayUnit,
        saleInfo: null,
        source: {
          adapterId: this.id,
          tier: this.tier,
          storeId,
          storeName: s.storeName,
        },
        timestamp: s.timestamp,
        confidence: getConfidenceLevel(1),
      };
    });
  }

  /**
   * Scan a receipt image for prices.
   * Placeholder — OCR not yet implemented.
   */
  async scanReceipt(
    _imageUri: string,
  ): Promise<SubmittedPrice[]> {
    console.log('OCR not yet implemented — scanReceipt is a placeholder');
    return [];
  }

  /**
   * Clear all stored prices (for testing / user request).
   */
  clearAllPrices(): void {
    this.prices.clear();
  }

  /**
   * Get list of stores that have crowd-sourced price data.
   */
  async getAvailableStores(): Promise<{ storeId: string; storeName: string }[]> {
    const stores: { storeId: string; storeName: string }[] = [];
    for (const [storeId, itemMap] of this.prices) {
      if (itemMap.size > 0) {
        // Get store name from first submission
        const items = Array.from(itemMap.values());
        const firstItem = items.find(arr => arr.length > 0);
        const name = firstItem && firstItem[0] ? firstItem[0].storeName : storeId;
        stores.push({ storeId, storeName: name });
      }
    }
    return stores.sort((a, b) => a.storeName.localeCompare(b.storeName));
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const crowdsourcedAdapter = new CrowdsourcedAdapter();