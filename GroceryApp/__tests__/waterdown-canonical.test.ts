/**
 * Canonical Waterdown regression fixture — 4 Oct 2026.
 *
 * Deterministic arithmetic for the weekly list from the 4 Oct workflow
 * assessment. This is NOT a live price feed: every offer is flagged
 * `isFixture`, the clock is pinned, and the assumptions below are test-only.
 *
 * Test-only assumptions (not confirmed quantities, products or evidence):
 *  - One purchase unit / package of each costed line; one mango, one
 *    cantaloupe and 1 kg of grapes.
 *  - The No Frills mayo and beef-patty candidates are ASSUMED to be the
 *    garlic and Jamaican variants (see ASSUMED_COMPATIBLE). With their
 *    plain listing names they stay unresolved, as production must.
 *  - Stock, branch and membership details beyond those listed are unknown
 *    and left unset; nothing here asserts a Costco member price.
 *  - The regular-price ketchup offer is invented to prove a sale-only hold
 *    never buys at regular price. No ketchup sale is evidenced.
 *
 * Historical source verification (4 Oct 2026 20:11 UTC, in stock then, no
 * membership condition or expiry shown) for the grapes, carrots and
 * Cascade listings:
 *   https://www.fortinos.ca/en/green-seedless-grapes/p/20425775001_KG
 *   https://www.nofrills.ca/en/green-seedless-grapes/p/20425775001_KG?source=nspt
 *   https://www.fortinos.ca/en/mini-carrots/p/20117370001_EA?source=nspt
 *   https://www.nofrills.ca/en/platinum-dishwasher-detergent-fresh-39ct/p/20660832001_EA?source=sptd
 * That observation does not establish current stock or price validity.
 *
 * Run: npx jest __tests__/waterdown-canonical.test.ts
 */

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import type { PriceResult, PriceSourceTier } from '../src/pricing/types';
import {
  classifyMatch,
  filterEligiblePrices,
  ineligibleReason,
  parseItemConstraints,
  type BasketItem,
} from '../src/pricing/basket';
import { computeTripPlan } from '../src/pricing/trip-plan';
import { computeStopProposals } from '../src/pricing/stop-optimizer';
import { parseListText } from '../src/services/list-import';

// 4 Oct 2026 20:11 UTC — the source-verification instant
const NOW = Date.UTC(2026, 9, 4, 20, 11);
/** End of a local (EDT, UTC−4) calendar day in October 2026 */
const endOfDay = (day: number) => Date.UTC(2026, 9, day + 1, 3, 59, 59);

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterAll(() => {
  jest.useRealTimers();
});

const STORES = {
  'no-frills-waterdown': 'No Frills Waterdown',
  'fortinos-waterdown': 'Fortinos Waterdown',
  costco: 'Costco',
  'freshco': 'FreshCo',
};

function offer(
  storeId: keyof typeof STORES,
  price: number,
  matchedName: string,
  extra: Partial<PriceResult> = {},
  tier: PriceSourceTier = 'official',
): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: { adapterId: 'fixture', tier, storeId, storeName: STORES[storeId] },
    timestamp: NOW,
    confidence: 'real_time',
    matchedName,
    currency: 'CAD',
    isFixture: true,
    ...extra,
  };
}

// ─── The list ───────────────────────────────────────────────────────────────

/** Representative paste of the Keep note — a reconstruction, not the original. */
const PASTED = [
  '☐ Fudgsicles',
  '☐ Baby carrots',
  '☐ Whole LF milk',
  '☐ Cantaloupe',
  '☐ GREEN seedless grapes',
  '☐ Mangoes',
  'Costco',
  '☐ Elderberry gummies Oct 25',
  'A1 / A1 Cash & Carry',
  '☐ Ketchup, sale only',
  '☐ Cascade pods, sale only',
  '☐ Garlic mayo for kids',
  '☐ JAMAICAN beef patties',
].join('\n');

type Item = BasketItem & { unit: string };

const imported = parseListText(PASTED);
const IDS = ['fudg', 'carrots', 'milk', 'cantaloupe', 'grapes', 'mango', 'gummies',
  'ketchup', 'cascade', 'mayo', 'patties'];
const BASKET: Item[] = imported.items.map((line, i) => ({
  id: IDS[i],
  name: line.name,
  notes: line.notes,
  // Fixture quantities: one of each, 1 kg of grapes
  quantity: 1,
  unit: IDS[i] === 'grapes' ? 'kg' : line.unit,
}));
const byId = (id: string) => BASKET.find((b) => b.id === id)!;

// ─── The offers ─────────────────────────────────────────────────────────────

const SALE = { isOnSale: true, salePrice: 15, regularPrice: 15, saleEndDate: endOfDay(7), unitPriceVsRegular: 0, savingsPercent: 0 };

/** As listed: the mayo and patty names don't establish garlic / Jamaican. */
const AS_LISTED: Record<string, Record<string, PriceResult>> = {
  'no-frills-waterdown': {
    fudg: offer('no-frills-waterdown', 5.0, 'Fudgsicle 12 x 60 mL'),
    carrots: offer('no-frills-waterdown', 2.99, 'Baby carrots 340 g'),
    milk: offer('no-frills-waterdown', 6.25, 'Neilson lactose-free whole 3.25% milk 2 L', { unit: 'L', packageSize: 2 }),
    cantaloupe: offer('no-frills-waterdown', 3.99, 'Cantaloupe'),
    mango: offer('no-frills-waterdown', 1.69, 'Mango'),
    patties: offer('no-frills-waterdown', 9.99, 'Beef patties 1.17 kg'),
    mayo: offer('no-frills-waterdown', 3.5, 'Mayo 300 mL'),
    cascade: offer('no-frills-waterdown', 15.0, 'Cascade Platinum dishwasher detergent 39 pods',
      { saleInfo: SALE, validTo: endOfDay(7), stock: 'in_stock' }),
    grapes: offer('no-frills-waterdown', 8.8, 'Green seedless grapes', { unit: 'kg', stock: 'in_stock' }),
    ketchup: offer('no-frills-waterdown', 3.29, 'Ketchup 1 L'), // invented regular price
  },
  'fortinos-waterdown': {
    // No expiry was shown in the live verification — none is assigned here.
    grapes: offer('fortinos-waterdown', 6.59, 'Green seedless grapes', { unit: 'kg', stock: 'in_stock' }),
    carrots: offer('fortinos-waterdown', 1.29, 'Baby carrots 340 g', { validTo: endOfDay(7) }),
  },
  costco: {
    gummies: offer('costco', 19.99, 'Elderberry gummies 120 count', { validTo: endOfDay(25) }),
  },
  freshco: {
    grapes: offer('freshco', 3.17, 'Red seedless grapes', { unit: 'kg' }),
  },
};

/** Test-only compatibility assumption for the arithmetic below. */
const ASSUMED_COMPATIBLE: Record<string, Record<string, PriceResult>> = {
  ...AS_LISTED,
  'no-frills-waterdown': {
    ...AS_LISTED['no-frills-waterdown'],
    mayo: { ...AS_LISTED['no-frills-waterdown'].mayo, matchedName: 'Garlic mayo 300 mL' },
    patties: { ...AS_LISTED['no-frills-waterdown'].patties, matchedName: 'Jamaican beef patties 1.17 kg' },
  },
};

const opts = { now: NOW, includeFixtures: true };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('list import', () => {
  it('reads 11 unchecked item lines; Costco and A1 are headings, not products', () => {
    expect(imported.items).toHaveLength(11);
    expect(imported.headings).toEqual(['Costco', 'A1 / A1 Cash & Carry']);
    expect(imported.items.every((i) => !i.checked)).toBe(true);
    expect(imported.items.map((i) => i.name)).not.toContain('Costco');
  });

  it('keeps notes, emphasis, raw text and store hints', () => {
    expect(byId('ketchup')).toMatchObject({ name: 'Ketchup', notes: 'sale only' });
    expect(byId('gummies')).toMatchObject({ name: 'Elderberry gummies', notes: 'Oct 25' });
    expect(byId('grapes').name).toBe('GREEN seedless grapes');
    expect(imported.items[6]).toMatchObject({ raw: '☐ Elderberry gummies Oct 25', storeHint: 'Costco' });
    expect(imported.items.every((i) => !i.quantitySpecified)).toBe(true);
  });
});

describe('constraints are reviewable, not invented', () => {
  it('LF means lactose free and is a hard variant', () => {
    const c = parseItemConstraints(byId('milk'));
    expect(c.requiredTokens).toEqual(expect.arrayContaining(['whole', 'lactose', 'free', 'milk']));
    expect(c.hardTokens).toEqual(['lactose', 'free']);
  });

  it('GREEN and JAMAICAN are hard; "for kids" is context, not a constraint', () => {
    expect(parseItemConstraints(byId('grapes')).hardTokens).toEqual(['green']);
    expect(parseItemConstraints(byId('patties')).hardTokens).toEqual(['jamaican']);
    const mayo = parseItemConstraints(byId('mayo'));
    expect(mayo.requiredTokens).toEqual(['garlic', 'mayo']);
    expect(mayo.context).toEqual(['for kids']);
  });

  it('the Oct 25 note is context only', () => {
    const c = parseItemConstraints(byId('gummies'));
    expect(c.context).toEqual(['Oct 25']);
    expect(c.requiredTokens).toEqual(['elderberry', 'gummy']);
  });
});

describe('eligibility', () => {
  it('as listed, the mayo and patties stay unresolved — never verified matches', () => {
    const nf = AS_LISTED['no-frills-waterdown'];
    expect(classifyMatch(nf.mayo, byId('mayo'))).toBe('unresolved');
    expect(classifyMatch(nf.patties, byId('patties'))).toBe('unresolved');
    expect(ineligibleReason(nf.patties, byId('patties'), opts)).toBe('unresolved_match');
  });

  it('red grapes are rejected for GREEN grapes', () => {
    expect(ineligibleReason(AS_LISTED.freshco.grapes, byId('grapes'), opts)).toBe('variant_mismatch');
    expect(filterEligiblePrices(BASKET, AS_LISTED, opts).freshco).toBeUndefined();
  });

  it('ketchup at regular price is not a sale', () => {
    expect(ineligibleReason(AS_LISTED['no-frills-waterdown'].ketchup, byId('ketchup'), opts))
      .toBe('not_on_sale');
  });

  it('fixture prices are never used without opting in', () => {
    expect(filterEligiblePrices(BASKET, AS_LISTED, { now: NOW })).toEqual({});
  });

  it('on Oct 8 the carrots and Cascade offers have expired', () => {
    const later = { now: Date.UTC(2026, 9, 8, 12), includeFixtures: true };
    const eligible = filterEligiblePrices(BASKET, ASSUMED_COMPATIBLE, later);
    expect(eligible['fortinos-waterdown'].carrots).toBeUndefined();
    expect(eligible['no-frills-waterdown'].cascade).toBeUndefined();
    expect(eligible['fortinos-waterdown'].grapes).toBeDefined();
  });
});

describe('arithmetic under the fixture assumptions', () => {
  const eligible = filterEligiblePrices(BASKET, ASSUMED_COMPATIBLE, opts);

  it('two stops: No Frills $57.21 + Costco $19.99 = $77.20', () => {
    const plan = computeTripPlan(BASKET, eligible, 2, undefined, STORES);
    const subtotal = (id: string) => plan.stops.find((s) => s.storeId === id)?.subtotal;
    expect(subtotal('no-frills-waterdown')).toBe(57.21);
    expect(subtotal('costco')).toBe(19.99);
    expect(plan.totalCost).toBe(77.2);
  });

  it('three stops: No Frills $45.42 + Fortinos $7.88 + Costco $19.99 = $73.29', () => {
    const plan = computeTripPlan(BASKET, eligible, 3, undefined, STORES);
    const stop = (id: string) => plan.stops.find((s) => s.storeId === id)!;
    expect(stop('no-frills-waterdown').subtotal).toBe(45.42);
    expect(stop('fortinos-waterdown').subtotal).toBe(7.88);
    expect(stop('fortinos-waterdown').items.map((i) => i.itemId).sort()).toEqual(['carrots', 'grapes']);
    expect(stop('costco').subtotal).toBe(19.99);
    expect(plan.totalCost).toBe(73.29);
  });

  it('both totals price the same ten lines; ketchup is a visible hold, not a gap or a $0 line', () => {
    for (const maxStops of [2, 3]) {
      const plan = computeTripPlan(BASKET, eligible, maxStops, undefined, STORES);
      expect(plan.stops.reduce((n, s) => n + s.items.length, 0)).toBe(10);
      expect(plan.held.map((i) => i.itemId)).toEqual(['ketchup']);
      expect(plan.unassigned).toEqual([]);
    }
  });

  it('no single store covers the same items, so there is no 1-stop saving to claim', () => {
    const plan = computeTripPlan(BASKET, eligible, 3, undefined, STORES);
    expect(plan.savingsComparable).toBe(false);
    expect(plan.savings).toBe(0);
  });

  it('route cards: the third stop saves $3.91 in merchandise; Fortinos alone is never "cheapest"', () => {
    const proposals = computeStopProposals(BASKET, eligible, STORES, 3);
    expect(proposals.map((p) => p.totalCost)).toEqual([57.21, 77.2, 73.29]);
    expect(proposals[0].stores[0].storeId).toBe('no-frills-waterdown');
    expect(proposals[0]).toMatchObject({ coveredCount: 9, totalCount: 11, heldItemIds: ['ketchup'] });
    expect(proposals[1]).toMatchObject({ coveredCount: 10, incrementalSavings: null });
    expect(proposals[2]).toMatchObject({ coveredCount: 10 });
    expect(proposals[2].incrementalSavings).toBeCloseTo(3.91, 2);
    expect(proposals.some((p) => p.numStops === 1 && p.stores[0].storeId === 'fortinos-waterdown')).toBe(false);
  });

  it('lines record what goes home: one 2 L milk carton, 1 kg of grapes by weight', () => {
    const plan = computeTripPlan(BASKET, eligible, 3, undefined, STORES);
    const line = (id: string) => plan.stops.flatMap((s) => s.items).find((i) => i.itemId === id)!;
    expect(line('milk')).toMatchObject({ packages: 1, purchased: { amount: 2, unit: 'L' }, lineTotal: 6.25 });
    expect(line('grapes')).toMatchObject({ purchased: { amount: 1, unit: 'kg' }, lineTotal: 6.59 });
    expect(line('grapes').packages).toBeUndefined();
    expect(line('grapes').evidence).toBe('Test data');
  });
});
