/**
 * Logged prices — turns the "Log Price" form into a SubmittedPrice the
 * planner can use without guessing.
 *
 *  - The store id is the same kebab-case id the adapters use ("No Frills" →
 *    "no-frills"). The form used to produce "no_frills", which created a
 *    second store and left the real store's price unchanged.
 *  - Package size is recorded only when the person enters it ("340 g", "2 L",
 *    "6 ea"), or the price is marked per kg / per lb. The list quantity is how
 *    much you NEED, not what one package holds, so it is never used as the
 *    package size.
 *  - Items counted in packages ("1 bunch", "3 ea") need no size: the price is
 *    for one of those. A measured item ("2 L", "500 g") with neither a package
 *    size nor a per-weight price is rejected with a message rather than stored
 *    as a guess.
 */

import type { SubmittedPrice } from './types';
import { parseUnit } from './quantity';

export function storeIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface LoggedPriceForm {
  itemName: string;
  /** The list item's unit ('' when none). */
  itemUnit: string;
  price: string;
  storeName: string;
  /** e.g. "340 g"; optional. */
  packageSize?: string;
  /** The price is a rate per kg / per lb (weighed goods). */
  perWeight?: 'kg' | 'lb';
  submittedBy: string;
}

export type LoggedPriceResult =
  | { ok: true; submission: Omit<SubmittedPrice, 'id' | 'timestamp'> }
  | { ok: false; error: string };

const PACKAGE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*([A-Za-z]+)\s*$/;

export function buildLoggedPrice(form: LoggedPriceForm): LoggedPriceResult {
  const price = parseFloat(form.price.replace(',', '.'));
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'Enter a valid price' };
  const storeName = form.storeName.trim();
  const storeId = storeIdFromName(storeName);
  if (!storeId) return { ok: false, error: 'Enter the store name' };

  const base = { itemName: form.itemName, storeId, storeName, price, submittedBy: form.submittedBy };

  if (form.perWeight) {
    return { ok: true, submission: { ...base, unit: form.perWeight, quantity: 1, pricingBasis: 'measure' } };
  }

  if (form.packageSize && form.packageSize.trim()) {
    const m = form.packageSize.match(PACKAGE_RE);
    const amount = m ? parseFloat(m[1]!.replace(',', '.')) : NaN;
    if (!m || !(amount > 0) || !parseUnit(m[2])) {
      return { ok: false, error: 'Package size looks like "340 g", "2 L" or "6 ea"' };
    }
    return { ok: true, submission: { ...base, unit: m[2]!, quantity: amount, pricingBasis: 'package' } };
  }

  const itemUnit = parseUnit(form.itemUnit);
  if (itemUnit && itemUnit[0] !== 'count') {
    return {
      ok: false,
      error: 'Enter the package size (e.g. 2 L or 340 g), or mark the price as per kg / per lb',
    };
  }
  // Counted in plain units or package words: the price is for one of them.
  return { ok: true, submission: { ...base, unit: form.itemUnit.trim() || 'ea', quantity: 1, pricingBasis: 'package' } };
}
