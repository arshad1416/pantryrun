/**
 * Price Subsystem — Core Types.
 *
 * Types for the price subsystem: price sources, confidence levels,
 * sale detection, and crowd-sourced price submissions.
 */

export type PriceSourceTier = 'official' | 'flyer' | 'crowd' | 'scraping';

export type ConfidenceLevel = 'real_time' | 'recent' | 'stale' | 'estimated';

export interface SaleInfo {
  isOnSale: boolean;
  salePrice: number;
  regularPrice: number;
  saleEndDate: number | null;
  /** Negative = real savings, positive = fake markdown */
  unitPriceVsRegular: number;
  savingsPercent: number;
}

export interface PriceResult {
  price: number;
  unitPrice: number;
  unit: string;
  displayUnit?: string; // e.g. "/100g", "/100mL", "/ea" — computed by normalizeUnitPrice
  saleInfo: SaleInfo | null;
  source: PriceSource;
  timestamp: number;
  confidence: ConfidenceLevel;
  imageUrl?: string;
  /** Offer end (epoch ms). A price past this instant must not be used. */
  validTo?: number;
  /** Product name the adapter actually matched — checked against variant constraints. */
  matchedName?: string;
  /** Amount of `unit` the price buys (e.g. 4 with unit 'L' for a 4 L jug). */
  packageSize?: number;
  /** Seeded demo data, not an observed price. */
  isDemo?: boolean;
}

export interface PriceSource {
  adapterId: string;
  tier: PriceSourceTier;
  storeId: string;
  storeName: string;
}

export interface SubmittedPrice {
  id: string;
  itemName: string;
  storeId: string;
  storeName: string;
  price: number;
  unit: string;
  quantity: number;
  timestamp: number;
  submittedBy: string; // deviceId or family member
}

/** Normalized item name → store key for internal price maps */
export type NormalizedItemKey = string;