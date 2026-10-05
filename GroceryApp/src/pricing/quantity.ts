/**
 * Quantity — what an item needs, and what buying it at an offer costs.
 *
 * Rules (each is tested in __tests__/shopping-plan-correctness.test.ts):
 *
 *  - Quantities: a positive finite number is a requirement; 0 is preserved
 *    and means "nothing to buy" (the item leaves the basket); negative or
 *    non-finite values are rejected; null/undefined is unknown. None of
 *    these is silently turned into 1.
 *  - Units: compatible units convert (g↔kg, mL↔L, each↔dozen). Mass,
 *    volume and count never convert into each other — no guessed density
 *    or piece weight.
 *  - Fixed packs: whole packages only, by ceiling division (500 g from
 *    340 g bags = 2 bags = 680 g purchased).
 *  - Weighed goods ('measure' pricing): fractional amounts at the per-unit
 *    rate (1.5 kg at $6.59/kg).
 *  - A price in a measure unit with no package size and no explicit basis
 *    is ambiguous (shelf unit price or package price?) and is not costed.
 *  - Multi-buy, per-customer limits and known stock are applied to the
 *    package count. A line is bought at one store; splitting one line
 *    across stores is not supported, so a stock or limit shortfall makes
 *    the offer unusable instead of being split.
 *
 * Currency: all arithmetic is in integer cents. A fractional line (weighed
 * goods, multi-buy remainders) is rounded once, half-up, to the cent; the
 * basket total is the sum of rounded lines.
 */

import type { PriceResult } from './types';

// ─── Units ──────────────────────────────────────────────────────────────────

export type Dimension = 'count' | 'mass' | 'volume';

/** unit → [dimension, size in base unit (each, g, mL)] */
const UNITS: Record<string, [Dimension, number]> = {
  each: ['count', 1], ea: ['count', 1], pc: ['count', 1], pcs: ['count', 1],
  piece: ['count', 1], pieces: ['count', 1], unit: ['count', 1], units: ['count', 1],
  ct: ['count', 1], count: ['count', 1], dozen: ['count', 12], doz: ['count', 12],
  g: ['mass', 1], gram: ['mass', 1], grams: ['mass', 1], kg: ['mass', 1000],
  lb: ['mass', 453.592], lbs: ['mass', 453.592], oz: ['mass', 28.3495],
  ml: ['volume', 1], l: ['volume', 1000], litre: ['volume', 1000], liter: ['volume', 1000],
  litres: ['volume', 1000], liters: ['volume', 1000],
};

/** Words that mean "one package of whatever size the store sells". */
const PACKAGE_WORDS = new Set([
  '', 'pack', 'pk', 'pkg', 'package', 'packages', 'bag', 'bags', 'box', 'boxes',
  'carton', 'cartons', 'bottle', 'bottles', 'can', 'cans', 'jar', 'jars',
  'tub', 'tubs', 'bunch', 'bunches', 'loaf', 'loaves', 'tray', 'case', 'container',
]);

export function parseUnit(unit: string | undefined): [Dimension, number] | null {
  return UNITS[(unit ?? '').trim().toLowerCase()] ?? null;
}

function isPackageWord(unit: string | undefined): boolean {
  return PACKAGE_WORDS.has((unit ?? '').trim().toLowerCase());
}

const DISPLAY_BASE: Record<Dimension, string> = { count: 'ea', mass: 'g', volume: 'mL' };

// ─── Requirements ───────────────────────────────────────────────────────────

export type Requirement =
  /** n packages of the store's size ("2 bags", or no unit) */
  | { kind: 'packages'; packages: number }
  /** an amount in a measurable dimension, in base units (each, g, mL) */
  | { kind: 'amount'; dimension: Dimension; base: number };

export type RequirementResult =
  | { ok: true; requirement: Requirement }
  | { ok: false; reason: 'quantity_unknown' | 'quantity_invalid' | 'quantity_zero' | 'unit_unknown' };

/** Classify a raw quantity without guessing. */
export function quantityStatus(qty: unknown): 'ok' | 'zero' | 'unknown' | 'invalid' {
  if (qty === null || qty === undefined || qty === '') return 'unknown';
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return 'invalid';
  if (qty < 0) return 'invalid';
  if (qty === 0) return 'zero';
  return 'ok';
}

export function parseRequirement(qty: number | null | undefined, unit?: string): RequirementResult {
  const status = quantityStatus(qty);
  if (status === 'unknown') return { ok: false, reason: 'quantity_unknown' };
  if (status === 'invalid') return { ok: false, reason: 'quantity_invalid' };
  if (status === 'zero') return { ok: false, reason: 'quantity_zero' };
  const q = qty as number;
  const parsed = parseUnit(unit);
  if (parsed) return { ok: true, requirement: { kind: 'amount', dimension: parsed[0], base: q * parsed[1] } };
  if (isPackageWord(unit)) return { ok: true, requirement: { kind: 'packages', packages: q } };
  return { ok: false, reason: 'unit_unknown' };
}

// ─── Offer basis ────────────────────────────────────────────────────────────

type OfferBasis =
  /** one package; `content` is its size in base units when known */
  | { kind: 'package'; dimension: Dimension | null; content: number | null }
  /** a rate per `perBase` base units (weighed / measured goods) */
  | { kind: 'measure'; dimension: Dimension; perBase: number }
  | { kind: 'ambiguous' };

export function offerBasis(pr: PriceResult): OfferBasis {
  const unit = parseUnit(pr.unit);
  const size = pr.packageSize !== undefined && pr.packageSize > 0 ? pr.packageSize : null;

  if (pr.pricingBasis === 'measure') {
    return unit ? { kind: 'measure', dimension: unit[0], perBase: unit[1] } : { kind: 'ambiguous' };
  }
  if (size !== null) {
    if (unit) return { kind: 'package', dimension: unit[0], content: size * unit[1] };
    // "1 bag" is one package of unknown content; "3 bags" for one price is unclear.
    if (isPackageWord(pr.unit) && size === 1) return { kind: 'package', dimension: null, content: null };
    return { kind: 'ambiguous' }; // "4 of what?"
  }
  // No package size.
  if (unit?.[0] === 'count') return { kind: 'package', dimension: 'count', content: unit[1] };
  if (!unit && isPackageWord(pr.unit)) return { kind: 'package', dimension: null, content: null };
  if (pr.pricingBasis === 'package' && unit) return { kind: 'package', dimension: unit[0], content: null };
  // A mass/volume unit with no size: shelf unit price or package price — unknown.
  return { kind: 'ambiguous' };
}

// ─── Purchases ──────────────────────────────────────────────────────────────

export interface Purchase {
  /** What the line costs, in integer cents. */
  costCents: number;
  /** Packages bought (null for weighed goods). */
  packages: number | null;
  /** Amount bought, e.g. "680 g", "4 L", "1.5 kg", "2 pkg". */
  purchasedLabel: string;
  /** Short arithmetic shown to the person, e.g. "2 × $2.99". */
  breakdown: string;
}

export type PurchaseFailure =
  | 'unit_incompatible'
  | 'pack_size_unknown'
  | 'exceeds_limit'
  | 'insufficient_stock';

export type PurchaseResult = { ok: true; purchase: Purchase } | { ok: false; reason: PurchaseFailure };

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Round a fractional cent amount half-up (epsilon absorbs float noise). */
export function roundHalfUpCents(cents: number): number {
  return Math.floor(cents + 0.5 + 1e-9);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatAmount(base: number, dimension: Dimension): string {
  if (dimension === 'mass' && base >= 1000) return `${+(base / 1000).toFixed(3)} kg`;
  if (dimension === 'volume' && base >= 1000) return `${+(base / 1000).toFixed(3)} L`;
  return `${+base.toFixed(2)} ${DISPLAY_BASE[dimension]}`;
}

/** Cost of buying `packages` packages under the offer's multi-buy / limit / stock terms. */
function packagePurchase(pr: PriceResult, packages: number, content: number | null, dimension: Dimension | null): PurchaseResult {
  let n = packages;
  const unitCents = toCents(pr.price);
  let costCents: number;
  let breakdown: string;

  if (pr.multiBuy && pr.multiBuy.groupSize > 1) {
    const { groupSize, groupPrice, requiresFullGroup } = pr.multiBuy;
    const groupCents = toCents(groupPrice);
    if (requiresFullGroup) {
      const groups = Math.ceil(n / groupSize);
      n = groups * groupSize;
      costCents = groups * groupCents;
      breakdown = `${groups} × ${groupSize} for ${formatCents(groupCents)}`;
    } else {
      const groups = Math.floor(n / groupSize);
      const rest = n - groups * groupSize;
      costCents = groups * groupCents + rest * unitCents;
      breakdown = rest > 0
        ? `${groups} × ${groupSize} for ${formatCents(groupCents)} + ${rest} × ${formatCents(unitCents)}`
        : `${groups} × ${groupSize} for ${formatCents(groupCents)}`;
    }
  } else {
    costCents = n * unitCents;
    breakdown = `${n} × ${formatCents(unitCents)}`;
  }

  if (pr.limitPerCustomer !== undefined && n > pr.limitPerCustomer) {
    const regular = pr.saleInfo?.regularPrice;
    if (regular === undefined || !(regular > 0)) return { ok: false, reason: 'exceeds_limit' };
    const extra = n - pr.limitPerCustomer;
    costCents = pr.limitPerCustomer * unitCents + extra * toCents(regular);
    breakdown = `${pr.limitPerCustomer} × ${formatCents(unitCents)} (limit) + ${extra} × ${formatCents(toCents(regular))}`;
  }
  if (pr.stockQuantity !== undefined && n > pr.stockQuantity) {
    return { ok: false, reason: 'insufficient_stock' };
  }

  const purchasedLabel = content !== null && dimension !== null
    ? formatAmount(n * content, dimension)
    : `${n} pkg`;
  return { ok: true, purchase: { costCents, packages: n, purchasedLabel, breakdown } };
}

/**
 * What it costs to satisfy `requirement` with offer `pr`, or why it can't.
 */
export function purchaseFor(requirement: Requirement, pr: PriceResult): PurchaseResult {
  const basis = offerBasis(pr);
  if (basis.kind === 'ambiguous') return { ok: false, reason: 'pack_size_unknown' };

  if (requirement.kind === 'packages') {
    // "2 bags" — any package-priced offer; a per-kg rate can't price a bag.
    if (basis.kind === 'measure') return { ok: false, reason: 'unit_incompatible' };
    return packagePurchase(pr, Math.ceil(requirement.packages - 1e-9), basis.content, basis.dimension);
  }

  const { dimension, base } = requirement;
  if (basis.kind === 'measure') {
    if (basis.dimension !== dimension) return { ok: false, reason: 'unit_incompatible' };
    if (dimension === 'count') {
      // A per-each rate: whole pieces only.
      return packagePurchase(pr, Math.ceil(base / basis.perBase - 1e-9), basis.perBase, 'count');
    }
    const amount = base / basis.perBase;
    const priceCents = toCents(pr.price);
    const costCents = roundHalfUpCents(amount * priceCents);
    if (pr.stockQuantity !== undefined && amount > pr.stockQuantity) {
      return { ok: false, reason: 'insufficient_stock' };
    }
    return {
      ok: true,
      purchase: {
        costCents,
        packages: null,
        purchasedLabel: formatAmount(base, dimension),
        breakdown: `${+amount.toFixed(3)} ${pr.unit} × ${formatCents(priceCents)}/${pr.unit}`,
      },
    };
  }

  // Package offer.
  if (basis.dimension !== dimension) {
    return { ok: false, reason: basis.dimension === null ? 'pack_size_unknown' : 'unit_incompatible' };
  }
  if (basis.content === null) return { ok: false, reason: 'pack_size_unknown' };
  // Small epsilon so 1000 mL of a 1 L carton is 1 carton, not 2.
  const packages = Math.ceil(base / basis.content - 1e-9);
  return packagePurchase(pr, packages, basis.content, dimension);
}
