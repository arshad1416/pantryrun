/**
 * Manual offer entry — turns the "Log Price" form into a SubmittedPrice with
 * evidence, so a price someone typed in is usable by the planner and visibly
 * sourced ("Entered by your family").
 *
 *  - The store id is the same kebab-case id the adapters use ("No Frills" →
 *    "no-frills"); the form used to produce "no_frills", which created a
 *    second, unrelated store and left the real one's price unchanged.
 *  - Package size is only recorded when typed ("340 g", "4 L", "6 ea"); it is
 *    never copied from the list quantity, which is how much you NEED, not
 *    what one package holds.
 *  - A sale end date (YYYY-MM-DD) makes the price a dated sale the planner
 *    judges against your shopping window.
 */

import type { SubmittedPrice } from './types';
import { unitDef } from './units';

export function storeIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ManualOfferForm {
  itemName: string;
  price: string;
  storeName: string;
  /** e.g. "340 g"; optional. */
  packageSize?: string;
  /** "per kg" / "per lb" when the price is by weight. */
  byWeight?: 'per_kg' | 'per_lb';
  /** YYYY-MM-DD; optional. */
  saleEnds?: string;
  submittedBy: string;
}

export type ManualOfferResult =
  | { ok: true; submission: Omit<SubmittedPrice, 'id' | 'timestamp'> }
  | { ok: false; error: string };

const PACKAGE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*([A-Za-z]+)\s*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildManualOffer(form: ManualOfferForm): ManualOfferResult {
  const price = parseFloat(form.price.replace(',', '.'));
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'Enter a valid price' };
  const storeName = form.storeName.trim();
  const storeId = storeIdFromName(storeName);
  if (!storeId) return { ok: false, error: 'Enter the store name' };

  let packageSize: { amount: number; unit: string } | undefined;
  if (form.packageSize && form.packageSize.trim()) {
    const m = form.packageSize.match(PACKAGE_RE);
    const amount = m ? parseFloat(m[1]!.replace(',', '.')) : NaN;
    if (!m || !(amount > 0) || !unitDef(m[2]!)) {
      return { ok: false, error: 'Package size looks like "340 g", "2 L" or "6 ea"' };
    }
    packageSize = { amount, unit: m[2]! };
  }

  let validTo: string | undefined;
  if (form.saleEnds && form.saleEnds.trim()) {
    const d = form.saleEnds.trim();
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      return { ok: false, error: 'Sale end date must be YYYY-MM-DD' };
    }
    validTo = d;
  }

  return {
    ok: true,
    submission: {
      itemName: form.itemName,
      storeId,
      storeName,
      price,
      unit: packageSize?.unit ?? (form.byWeight === 'per_lb' ? 'lb' : form.byWeight === 'per_kg' ? 'kg' : 'ea'),
      quantity: packageSize?.amount ?? 1,
      submittedBy: form.submittedBy,
      evidence: {
        packageSize,
        priceBasis: form.byWeight ?? 'per_package',
        ...(validTo ? { validTo, isSale: true } : {}),
        channel: 'in_store',
      },
    },
  };
}
