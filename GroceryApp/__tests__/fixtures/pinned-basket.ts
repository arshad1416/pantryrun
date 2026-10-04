/**
 * Pinned basket fixture — deterministic test data, NOT production prices.
 *
 * Every price here is invented for testing. It is kept out of src/ so it can
 * never be shipped or mistaken for a feed. The arithmetic is pinned:
 *
 *   eligible lines        10 (ketchup is held: sale-only, no valid sale)
 *   1 stop  No Frills     $85.76  complete
 *   2 stops NF + Food Basics          $77.20  complete
 *   3 stops NF + FB + FreshCo         $73.29  complete  (extra stop saves $3.91)
 *   Fortinos alone        $7.88   2 of 10 lines
 *   FB + FreshCo          $60.31  9 of 10 lines — cheaper only because it
 *                                 omits the patties; must NOT win.
 *
 * Evaluated at NOW (Sun Oct 4 2026, noon Toronto) for the window Mon Oct 5 –
 * Sat Oct 10. FreshCo's milk sale ends Wed Oct 7 (inside the window).
 */

import type { OfferEvidence, OfferProvenance, PriceResult } from '../../src/pricing/types';
import type { LineSource } from '../../src/pricing/list-intent';

export const NOW = Date.parse('2026-10-04T16:00:00Z'); // 12:00 America/Toronto
export const OBSERVED = Date.parse('2026-10-03T14:00:00Z');
export const WINDOW = { start: '2026-10-05', end: '2026-10-10' };
export const TZ = 'America/Toronto';

export const STORE_NAMES: Record<string, string> = {
  'no-frills': 'No Frills',
  'food-basics': 'Food Basics',
  freshco: 'FreshCo',
  fortinos: 'Fortinos',
  costco: 'Costco',
};

export const ITEMS: LineSource[] = [
  { id: 'grapes', name: 'GREEN grapes', quantity: 1.5, unit: 'kg' },
  { id: 'milk', name: 'whole lactose-free milk', quantity: 2, unit: 'L' },
  { id: 'patties', name: 'JAMAICAN patties', quantity: 8, unit: 'ea' },
  { id: 'cheese', name: 'cheddar cheese', quantity: 500, unit: 'g' },
  { id: 'bananas', name: 'bananas', quantity: 1, unit: 'bunch' },
  { id: 'eggs', name: 'eggs', quantity: 12, unit: 'ea' },
  { id: 'bread', name: 'bread', quantity: 1, unit: 'loaf' },
  { id: 'rice', name: 'basmati rice', quantity: 2, unit: 'kg' },
  { id: 'chicken', name: 'chicken thighs', quantity: 2, unit: 'kg' },
  { id: 'yogurt', name: 'yogurt tubes', quantity: 1, unit: 'box', notes: 'for kids' },
  { id: 'ketchup', name: 'ketchup', quantity: 1, unit: 'bottle', notes: 'sale only' },
  { id: 'napkins', name: 'napkins', quantity: 1, unit: 'pack', isChecked: true },
];

function offer(
  storeId: string,
  price: number,
  ev: Partial<OfferEvidence> & { productName: string },
  provenance: OfferProvenance = 'manual',
): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: ev.packageSize?.unit ?? 'ea',
    saleInfo: null,
    source: { adapterId: 'fixture', tier: 'crowd', storeId, storeName: STORE_NAMES[storeId] ?? storeId },
    timestamp: OBSERVED,
    confidence: 'recent',
    evidence: {
      provenance,
      sourceLabel: 'Fixture (reviewed manual entry)',
      currency: 'CAD',
      channel: 'in_store',
      observedAt: OBSERVED,
      timezone: TZ,
      ...ev,
    },
  };
}

const kg = (n: number) => ({ amount: n, unit: 'kg' });

export function buildPrices(): Record<string, Record<string, PriceResult>> {
  return {
    'no-frills': {
      grapes: offer('no-frills', 5.8, { productName: 'Green seedless grapes', priceBasis: 'per_kg' }),
      milk: offer('no-frills', 6.49, { productName: 'Lactose free 3.25% milk 2 L', packageSize: { amount: 2, unit: 'L' } }),
      patties: offer('no-frills', 6.49, { productName: 'Jamaican beef patties 4 pk', packageSize: { amount: 4, unit: 'ea' } }),
      cheese: offer('no-frills', 5.49, { productName: 'Cheddar cheese 340 g', packageSize: { amount: 340, unit: 'g' } }),
      bananas: offer('no-frills', 1.59, { productName: 'Bananas', packageSize: { amount: 1, unit: 'bunch' } }),
      eggs: offer('no-frills', 5.99, { productName: 'Large eggs 12', packageSize: { amount: 12, unit: 'ea' } }),
      bread: offer('no-frills', 2.99, { productName: 'White bread', packageSize: { amount: 1, unit: 'loaf' } }),
      rice: offer('no-frills', 9.99, { productName: 'Basmati rice 2 kg', packageSize: kg(2) }),
      chicken: offer('no-frills', 11.13, { productName: 'Chicken thighs', priceBasis: 'per_kg' }),
      yogurt: offer('no-frills', 3.79, { productName: 'Yogurt tubes 8 pk', packageSize: { amount: 1, unit: 'box' } }),
      ketchup: offer('no-frills', 3.99, { productName: 'Ketchup 1 L', packageSize: { amount: 1, unit: 'bottle' } }),
    },
    'food-basics': {
      grapes: offer('food-basics', 3.96, { productName: 'Green grapes', priceBasis: 'per_kg' }),
      milk: offer('food-basics', 6.29, { productName: 'Lactose-free whole milk 2 L', packageSize: { amount: 2, unit: 'L' } }),
      // Not evidenced as Jamaican → cannot satisfy JAMAICAN patties.
      patties: offer('food-basics', 4.99, { productName: 'Beef patties 4 pk', packageSize: { amount: 4, unit: 'ea' } }),
      cheese: offer('food-basics', 5.29, { productName: 'Cheddar cheese 340 g', packageSize: { amount: 340, unit: 'g' } }),
      bananas: offer('food-basics', 1.49, { productName: 'Bananas', packageSize: { amount: 1, unit: 'bunch' } }),
      eggs: offer('food-basics', 3.99, { productName: 'Large eggs 12', packageSize: { amount: 12, unit: 'ea' } }),
      bread: offer('food-basics', 2.79, { productName: 'White bread', packageSize: { amount: 1, unit: 'loaf' } }),
      rice: offer('food-basics', 8.99, { productName: 'Basmati rice 2 kg', packageSize: kg(2) }),
      chicken: offer('food-basics', 10.33, { productName: 'Chicken thighs', priceBasis: 'per_kg' }),
      yogurt: offer('food-basics', 3.49, { productName: 'Yogurt tubes 8 pk', packageSize: { amount: 1, unit: 'box' } }),
      // Sale ended the day before the fixture's NOW.
      ketchup: offer(
        'food-basics',
        2.49,
        { productName: 'Ketchup 1 L', packageSize: { amount: 1, unit: 'bottle' }, isSale: true, validFrom: '2026-09-27', validTo: '2026-10-03' },
        'flyer',
      ),
    },
    freshco: {
      // Cheaper, but RED — must never satisfy GREEN grapes.
      grapes: offer('freshco', 2.18, { productName: 'Red seedless grapes', priceBasis: 'per_kg' }),
      milk: offer(
        'freshco',
        5.49,
        { productName: 'Lactose free whole milk 2 L', packageSize: { amount: 2, unit: 'L' }, isSale: true, validFrom: '2026-10-01', validTo: '2026-10-07' },
        'flyer',
      ),
      cheese: offer('freshco', 4.79, { productName: 'Cheddar cheese 340 g', packageSize: { amount: 340, unit: 'g' } }),
      rice: offer('freshco', 8.48, { productName: 'Basmati rice 2 kg', packageSize: kg(2) }),
      chicken: offer('freshco', 9.93, { productName: 'Chicken thighs', priceBasis: 'per_kg' }),
      yogurt: offer('freshco', 2.69, { productName: 'Yogurt tubes 8 pk', packageSize: { amount: 1, unit: 'box' } }),
      ketchup: offer('freshco', 3.79, { productName: 'Ketchup 1 L', packageSize: { amount: 1, unit: 'bottle' } }),
    },
    fortinos: {
      bananas: offer('fortinos', 1.49, { productName: 'Bananas', packageSize: { amount: 1, unit: 'bunch' } }),
      bread: offer('fortinos', 6.39, { productName: 'Artisan white bread', packageSize: { amount: 1, unit: 'loaf' } }),
    },
    costco: {
      cheese: offer('costco', 9.99, { productName: 'Cheddar cheese 1 kg', packageSize: kg(1), membershipRequired: 'Costco' }),
      rice: offer('costco', 12.99, { productName: 'Basmati rice 8 kg', packageSize: kg(8), membershipRequired: 'Costco' }),
    },
  };
}

/** A realistic Keep-style checklist export for the import tests. */
export const KEEP_PASTE = `Groceries
☐ GREEN grapes 1.5 kg
☐ whole lactose-free milk 2 L
☐ JAMAICAN patties x8
☐ ketchup (sale only)
☑ napkins
☐ yogurt tubes - for kids
Costco
☐ cheddar cheese 500 g
☐ basmati rice
A1 Cash & Carry:
☐ chicken thighs 2 kg
☐ grapes
☐ red grapes
`;
