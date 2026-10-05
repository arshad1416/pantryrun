/**
 * Waterdown weekly basket, 4 October 2026 — deterministic test fixture.
 *
 * RECONSTRUCTED. The workflow assessment this repo was asked to satisfy
 * stated its outcomes (Fortinos 2 items for $7.88; $77.20 at ≤2 stores,
 * $73.29 at ≤3, a $3.91 difference; 10 costed lines + 1 sale-only hold;
 * carrot and Cascade sales ending 7 Oct; Costco gummies ending 25 Oct) but
 * not its raw offer data, which is not in the repository. These offers are
 * illustrative values chosen to be consistent with every stated outcome.
 * They are NOT observed prices and must never be loaded by the app.
 *
 * Test assumptions:
 *  - clock pinned to 2026-10-04 12:00 America/Toronto
 *  - shopping today, in store, Costco membership confirmed
 *  - each line bought entirely at one store (no split purchases)
 *  - currency: integer cents, fractional lines rounded half-up once
 */

import type { PriceResult, PriceSourceTier } from '../../src/pricing/types';
import type { BasketItem, PlanContext, StoreOffers } from '../../src/pricing/basket';

export const TZ = 'America/Toronto';
/** 2026-10-04 12:00 EDT */
export const PINNED_NOW = Date.UTC(2026, 9, 4, 16, 0, 0);
/** 2026-10-08 12:00 EDT — the local day after the 7 Oct sale ends */
export const OCT_8_NOON = Date.UTC(2026, 9, 8, 16, 0, 0);
/** 2026-10-26 12:00 EDT — the local day after the 25 Oct Costco offer ends */
export const OCT_26_NOON = Date.UTC(2026, 9, 26, 16, 0, 0);

const OBSERVED_OCT_3 = Date.UTC(2026, 9, 3, 14, 0, 0);
const OBSERVED_OCT_2 = Date.UTC(2026, 9, 2, 14, 0, 0);

export const STORE_NAMES: Record<string, string> = {
  'no-frills': 'No Frills',
  fortinos: 'Fortinos',
  costco: 'Costco',
  'a1-cash-carry': 'A1 Cash & Carry',
};

const BRANCHES: Record<string, string> = {
  'no-frills': 'nf-waterdown',
  fortinos: 'fortinos-waterdown',
  costco: 'costco-burlington',
  'a1-cash-carry': 'a1-hamilton',
};

const CITIES: Record<string, string> = {
  'no-frills': 'Waterdown',
  fortinos: 'Waterdown',
  costco: 'Burlington',
  'a1-cash-carry': 'Hamilton',
};

/** A fully evidenced offer: known adapter, branch, channel and stock. */
export function offer(
  storeId: string,
  matchedName: string,
  price: number,
  extra: Partial<PriceResult> = {},
  tier: PriceSourceTier = 'official',
): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: {
      adapterId: 'fixture',
      tier,
      storeId,
      storeName: STORE_NAMES[storeId] ?? storeId,
      branchId: BRANCHES[storeId],
      city: CITIES[storeId],
      timeZone: TZ,
    },
    timestamp: OBSERVED_OCT_3,
    confidence: 'real_time',
    matchedName,
    channel: 'in_store',
    stockStatus: 'in_stock',
    offerType: 'regular',
    ...extra,
  };
}

/** The 11 real product lines (headings "Costco" / "A1 Cash & Carry" are not items). */
export const BASKET: BasketItem[] = [
  { id: 'milk', name: 'LF milk', quantity: 3, unit: 'L', notes: '3.25% only' },
  { id: 'grapes', name: 'green seedless grapes', quantity: 1.5, unit: 'kg' },
  { id: 'carrots', name: 'baby carrots', quantity: 500, unit: 'g' },
  { id: 'patties', name: 'Jamaican patties', quantity: 1, unit: '' },
  { id: 'mayo', name: 'garlic mayo', quantity: 1, unit: '' },
  { id: 'ketchup', name: 'ketchup', quantity: 1, unit: '', notes: 'sale only' },
  { id: 'cascade', name: 'Cascade pods', quantity: 1, unit: '', notes: 'sale only' },
  { id: 'gummies', name: 'gummies', quantity: 1, unit: '' },
  { id: 'eggs', name: 'eggs', quantity: 1, unit: 'dozen' },
  { id: 'bread', name: 'bread', quantity: 1, unit: '' },
  { id: 'rice', name: 'basmati rice', quantity: 1, unit: 'bag' },
];

export function buildOffers(): StoreOffers {
  return {
    'no-frills': {
      milk: [
        offer('no-frills', 'Neilson 2% Milk 4 L', 5.89, { unit: 'L', packageSize: 4 }),
        offer('no-frills', 'Lactantia Lactose Free 2% Milk 2 L', 5.79, { unit: 'L', packageSize: 2 }),
        offer('no-frills', 'Natrel Lactose Free 3.25% Milk 2 L', 6.25, { unit: 'L', packageSize: 2 }),
      ],
      grapes: offer('no-frills', 'Green Seedless Grapes', 6.59, {
        unit: 'kg', pricingBasis: 'measure', timestamp: OBSERVED_OCT_2,
      }),
      carrots: offer('no-frills', 'Baby Carrots 340 g', 4.5, { unit: 'g', packageSize: 340 }),
      patties: offer('no-frills', 'Tastee Jamaican Beef Patties 10 pk', 8.99, { unit: 'pk' }),
      mayo: offer('no-frills', "Hellmann's Roasted Garlic Mayonnaise 355 mL", 5.49, { unit: 'jar' }),
      ketchup: offer('no-frills', 'Heinz Tomato Ketchup 1 L', 4.99, { unit: 'bottle' }),
      cascade: offer('no-frills', 'Cascade Platinum Dishwasher Pods 62 ct', 9.99, {
        unit: 'box', offerType: 'sale', validThroughDate: '2026-10-07',
      }, 'flyer'),
      eggs: offer('no-frills', 'Large Eggs 12 pk', 4.29, { unit: 'ea', packageSize: 12 }),
      bread: offer('no-frills', 'Wonder White Bread 675 g', 2.79, { unit: 'loaf' }),
      rice: offer('no-frills', 'Basmati Rice 2 kg', 2.97, { unit: 'bag' }),
    },
    fortinos: {
      milk: offer('fortinos', 'Lactantia Lactose Free 1% Milk 2 L', 4.99, { unit: 'L', packageSize: 2 }),
      grapes: offer('fortinos', 'Red Seedless Grapes', 4.4, {
        unit: 'kg', pricingBasis: 'measure', offerType: 'sale', validThroughDate: '2026-10-07',
      }, 'flyer'),
      carrots: offer('fortinos', 'Baby Carrots 340 g', 2.99, {
        unit: 'g', packageSize: 340, offerType: 'sale', validThroughDate: '2026-10-07',
      }, 'flyer'),
      mayo: offer('fortinos', "Hellmann's Real Mayonnaise 890 mL", 3.99, { unit: 'jar' }),
      ketchup: offer('fortinos', 'Heinz Tomato Ketchup 1 L', 5.49, { unit: 'bottle' }),
      cascade: offer('fortinos', 'Cascade Platinum Pods 62 ct', 13.99, { unit: 'box' }),
      bread: offer('fortinos', "Dempster's White Bread 600 g", 1.9, { unit: 'loaf' }),
    },
    costco: {
      gummies: offer('costco', 'Kirkland Signature Fruit Gummies 90 ct', 11.29, {
        unit: 'box', offerType: 'sale', validThroughDate: '2026-10-25', requiresMembership: 'costco',
        saleInfo: { isOnSale: true, salePrice: 11.29, regularPrice: 16.29, saleEndDate: null, unitPriceVsRegular: -5, savingsPercent: 31 },
      }),
      mayo: offer('costco', 'Kirkland Signature Mayonnaise 1.89 L', 7.99, {
        unit: 'jar', requiresMembership: 'costco',
      }),
    },
    'a1-cash-carry': {
      patties: offer('a1-cash-carry', 'Beef Patties 12 pk', 6.99, { unit: 'pk' }),
      rice: offer('a1-cash-carry', 'Basmati Rice 2 kg', 2.49, { unit: 'bag' }),
    },
  };
}

/** The stated test assumptions as a plan context. */
export function fixtureContext(overrides: PlanContext = {}): PlanContext {
  return {
    now: PINNED_NOW,
    timeZone: TZ,
    channel: 'in_store',
    memberships: ['costco'],
    ...overrides,
  };
}

/**
 * A pasted checklist in Google Keep's export style: headings for stores,
 * checkbox lines, attached notes and explicit quantities.
 */
export const KEEP_CHECKLIST = `Groceries this week
☐ LF milk 3L (3.25% only)
☐ green seedless grapes 1.5 kg
☐ baby carrots 500 g
☐ Jamaican patties
☐ garlic mayo
☐ ketchup - sale only
☐ Cascade pods — sale only
☐ eggs 1 dozen
☐ bread
Costco:
☐ gummies
A1 Cash & Carry
☐ basmati rice 1 bag
`;
