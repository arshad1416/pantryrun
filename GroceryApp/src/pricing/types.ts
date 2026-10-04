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
  /**
   * What is actually known about this offer. Optional so legacy adapters
   * still compile; offer-evidence.ts derives a conservative default (provenance
   * 'unverified', everything else unknown) when it is absent.
   */
  evidence?: OfferEvidence;
}

/**
 * Where an offer came from, in decreasing order of how much the app may rely
 * on it. Only 'verified' and 'manual' can back a recommendation without an
 * "unverified" label; 'demo' is sample data and never backs a savings claim.
 */
export type OfferProvenance = 'verified' | 'manual' | 'flyer' | 'unverified' | 'demo';

/**
 * Evidence attached to an offer. Every field is optional: unknown stays
 * unknown and is never filled with a guess.
 */
export interface OfferEvidence {
  provenance: OfferProvenance;
  /** Human-readable source, e.g. "You entered this", "Flipp flyer". */
  sourceLabel?: string;
  /** The product the offer is actually for, as the source named it. */
  productName?: string;
  /** Variant tags the source evidences (e.g. 'green', 'lactose-free'). */
  attributes?: string[];
  /** Contents of one package (e.g. 340 g, 4 L, 6 ea). */
  packageSize?: { amount: number; unit: string };
  /** How `price` is quoted. Absent = per package. */
  priceBasis?: 'per_package' | 'per_kg' | 'per_lb' | 'per_100g';
  /** ISO 4217 code. */
  currency?: string;
  branchId?: string;
  channel?: 'in_store' | 'online' | 'delivery';
  /** When the price was observed (epoch ms). */
  observedAt?: number;
  /** First and last valid day, inclusive, as store-local YYYY-MM-DD. */
  validFrom?: string;
  validTo?: string;
  /** IANA timezone of the store; defaults to the device zone. */
  timezone?: string;
  stockStatus?: 'in_stock' | 'limited' | 'out_of_stock';
  /** Membership the price requires, e.g. 'Costco'. */
  membershipRequired?: string;
  /** Promotion requires buying at least this many packs. */
  minPacks?: number;
  /** The source itself labels this a sale/promotional price. */
  isSale?: boolean;
  /** The source has withdrawn the offer. */
  withdrawn?: boolean;
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
  /** Optional evidence the submitter supplied (sale end date, variant…). */
  evidence?: Partial<OfferEvidence>;
}

/** Normalized item name → store key for internal price maps */
export type NormalizedItemKey = string;