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

  // ─── Offer terms (all optional; absent means "the source didn't say") ────
  /** Offer start (epoch ms). */
  validFrom?: number;
  /**
   * Date-only offer window (YYYY-MM-DD, inclusive, in the store's local
   * time zone) for sources that publish a day but no time. The offer is
   * good through the end of that local day and not on the next one — no
   * exact expiry time is invented.
   */
  validFromDate?: string;
  validThroughDate?: string;
  /** Explicit promotional evidence. A sale-only item needs 'sale'. */
  offerType?: 'sale' | 'regular';
  /**
   * How `price` applies:
   *  - 'package': one package of `packageSize` `unit` (fixed pack — whole packages only)
   *  - 'measure': a rate per one `unit` (weighed goods — fractional amounts allowed)
   * Absent: inferred — a packageSize means 'package', a count unit means
   * per-each, anything else is ambiguous and not costed.
   */
  pricingBasis?: 'package' | 'measure';
  /** Multi-buy terms, e.g. "2 for $5": groupSize 2, groupPrice 5. */
  multiBuy?: { groupSize: number; groupPrice: number; requiresFullGroup: boolean };
  /** Most packages one customer may buy at this price. */
  limitPerCustomer?: number;
  /** Known stock at this branch; 'unknown' (or absent) is never verified stock. */
  stockStatus?: 'in_stock' | 'out_of_stock' | 'unknown';
  /** Packages known to be available, when the source reports a count. */
  stockQuantity?: number;
  /** Membership the offer requires (e.g. 'costco'). */
  requiresMembership?: string;
  /** Where the price applies. Absent = the source didn't say. */
  channel?: 'in_store' | 'online' | 'pickup';
  /** The source answered and no longer lists this offer. Kept for display only. */
  unavailable?: 'withdrawn';
  /** The last refresh for this store failed; this is a last-known price. */
  refreshFailedAt?: number;
}

export interface PriceSource {
  adapterId: string;
  tier: PriceSourceTier;
  storeId: string;
  storeName: string;
  /** Specific branch the observation came from. Absent = unknown branch. */
  branchId?: string;
  /** City of that branch, when known. */
  city?: string;
  /** IANA time zone of the branch (defaults to the plan's time zone). */
  timeZone?: string;
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