/**
 * Units & purchase arithmetic — the one place that turns "how much the list
 * needs" plus "how the offer is sold" into packs and a checkout line total.
 *
 * Rules (see docs/PRICE_COMPARISON.md):
 *  - Mass (g, kg, lb, oz), volume (mL, L) and count (ea, pcs, dozen) are only
 *    converted WITHIN a dimension. Count is never turned into mass or volume:
 *    "6 apples" against a per-kg price is incompatible, not guessed.
 *  - Fixed packs use ceiling division: 500 g from 340 g bags is 2 bags.
 *  - Weighed goods (per-kg / per-lb / per-100g pricing) may be bought in
 *    fractional amounts.
 *  - Package-word units (bag, bunch, box, …) only match the same word.
 *  - Unit price, required quantity, purchased quantity, pack count and line
 *    total are kept as separate fields — never folded into one number.
 */

export type Dimension = 'mass' | 'volume' | 'count' | 'package';

export interface Quantity {
  amount: number;
  unit: string;
}

interface UnitDef {
  dimension: Dimension;
  /** Multiplier to the dimension's base unit (g, mL, ea). Package units: 1. */
  toBase: number;
  /** Canonical spelling for display. */
  canonical: string;
}

const UNIT_TABLE: Record<string, UnitDef> = {
  g: { dimension: 'mass', toBase: 1, canonical: 'g' },
  gram: { dimension: 'mass', toBase: 1, canonical: 'g' },
  grams: { dimension: 'mass', toBase: 1, canonical: 'g' },
  kg: { dimension: 'mass', toBase: 1000, canonical: 'kg' },
  kilo: { dimension: 'mass', toBase: 1000, canonical: 'kg' },
  kilos: { dimension: 'mass', toBase: 1000, canonical: 'kg' },
  lb: { dimension: 'mass', toBase: 453.59237, canonical: 'lb' },
  lbs: { dimension: 'mass', toBase: 453.59237, canonical: 'lb' },
  oz: { dimension: 'mass', toBase: 28.349523125, canonical: 'oz' },
  ml: { dimension: 'volume', toBase: 1, canonical: 'mL' },
  l: { dimension: 'volume', toBase: 1000, canonical: 'L' },
  litre: { dimension: 'volume', toBase: 1000, canonical: 'L' },
  liter: { dimension: 'volume', toBase: 1000, canonical: 'L' },
  ea: { dimension: 'count', toBase: 1, canonical: 'ea' },
  each: { dimension: 'count', toBase: 1, canonical: 'ea' },
  pc: { dimension: 'count', toBase: 1, canonical: 'ea' },
  pcs: { dimension: 'count', toBase: 1, canonical: 'ea' },
  ct: { dimension: 'count', toBase: 1, canonical: 'ea' },
  count: { dimension: 'count', toBase: 1, canonical: 'ea' },
  dozen: { dimension: 'count', toBase: 12, canonical: 'ea' },
};

/** Look up a unit. Unknown non-empty words are package units (bag, bunch…). */
export function unitDef(unit: string): UnitDef | null {
  const key = unit.trim().toLowerCase().replace(/\.$/, '');
  if (!key) return null;
  const known = UNIT_TABLE[key];
  if (known) return known;
  // Plural package words collapse to singular so "bags" matches "bag".
  const singular = key.endsWith('es') && /(box|bunch)es$/.test(key)
    ? key.slice(0, -2)
    : key.endsWith('s') ? key.slice(0, -1) : key;
  return { dimension: 'package', toBase: 1, canonical: singular };
}

/** Convert a quantity to its dimension's base unit, or null if not convertible. */
export function toBase(q: Quantity): { dimension: Dimension; amount: number; unit: string } | null {
  const def = unitDef(q.unit);
  if (!def) return null;
  return { dimension: def.dimension, amount: q.amount * def.toBase, unit: def.canonical };
}

/** Round away binary noise so 0.3 / 0.1 does not ceil to 4. */
function clean(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

export function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type PriceBasis = 'per_package' | 'per_kg' | 'per_lb' | 'per_100g';

const WEIGHED_BASIS_GRAMS: Record<Exclude<PriceBasis, 'per_package'>, number> = {
  per_kg: 1000,
  per_lb: 453.59237,
  per_100g: 100,
};

export interface PurchaseInput {
  /** What the list needs. */
  required: Quantity;
  /** Shelf price, in the basis below. */
  price: number;
  priceBasis: PriceBasis;
  /** Contents of one package, when known (only meaningful for per_package). */
  packageSize?: Quantity;
}

export type PurchaseResult =
  | {
      ok: true;
      /** Packages to put in the cart (weighed goods: 1 — bought by weight). */
      packs: number;
      /** Amount actually bought (≥ required for fixed packs). */
      purchased: Quantity;
      /** What the checkout charges for this line, before tax. */
      lineTotal: number;
      /** Human description, e.g. "2 × 340 g bag" or "0.75 kg @ $4.40/kg". */
      description: string;
    }
  | { ok: false; reason: string };

function fmtAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(clean(n));
}

/**
 * Work out what to buy and what it costs. Never guesses a conversion between
 * dimensions or invents a package size.
 */
export function planPurchase(input: PurchaseInput): PurchaseResult {
  const { required, price, priceBasis, packageSize } = input;
  if (!(price >= 0) || !Number.isFinite(price)) {
    return { ok: false, reason: 'offer has no usable price' };
  }
  if (!(required.amount > 0)) {
    return { ok: false, reason: 'nothing to buy (quantity is 0)' };
  }
  const need = toBase(required);
  if (!need) {
    return { ok: false, reason: 'list quantity has no unit' };
  }

  if (priceBasis !== 'per_package') {
    if (need.dimension !== 'mass') {
      return {
        ok: false,
        reason: `sold by weight; the list asks for ${fmtAmount(required.amount)} ${required.unit || 'ea'} and the weight of that is unknown`,
      };
    }
    const basisGrams = WEIGHED_BASIS_GRAMS[priceBasis];
    const lineTotal = roundMoney((need.amount / basisGrams) * price);
    return {
      ok: true,
      packs: 1,
      purchased: { amount: required.amount, unit: required.unit },
      lineTotal,
      description: `${fmtAmount(required.amount)} ${required.unit} by weight`,
    };
  }

  // Fixed package. Without a known size, a package is "one of whatever the
  // list counts in" only when the list counts in plain units or the same
  // package word; anything else would be guessing package contents.
  if (!packageSize) {
    if (need.dimension === 'count' || need.dimension === 'package') {
      const packs = Math.ceil(clean(need.amount));
      return {
        ok: true,
        packs,
        purchased: { amount: packs, unit: required.unit || 'ea' },
        lineTotal: roundMoney(packs * price),
        description: `${packs} × ${required.unit || 'ea'}`,
      };
    }
    return {
      ok: false,
      reason: `package size unknown; cannot tell how many packs make ${fmtAmount(required.amount)} ${required.unit}`,
    };
  }

  const pkg = toBase(packageSize);
  if (!pkg || !(pkg.amount > 0)) {
    return { ok: false, reason: 'offer package size is invalid' };
  }
  if (pkg.dimension !== need.dimension || (pkg.dimension === 'package' && pkg.unit !== need.unit)) {
    return {
      ok: false,
      reason: `list asks for ${fmtAmount(required.amount)} ${required.unit || 'ea'} but the offer is a ${fmtAmount(packageSize.amount)} ${packageSize.unit} package (${need.dimension} vs ${pkg.dimension})`,
    };
  }
  const packs = Math.max(1, Math.ceil(clean(need.amount / pkg.amount)));
  return {
    ok: true,
    packs,
    purchased: { amount: clean(packs * packageSize.amount), unit: packageSize.unit },
    lineTotal: roundMoney(packs * price),
    description: `${packs} × ${fmtAmount(packageSize.amount)} ${packageSize.unit}`,
  };
}
