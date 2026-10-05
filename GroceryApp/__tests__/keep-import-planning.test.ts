/**
 * Keep import → planner — acceptance case G against src/import/keep.ts.
 *
 * The importer itself is covered by keep-import.test.ts; this checks that
 * what it produces keeps the meaning the planner depends on: store
 * headings are not products, the 11 real lines survive with their
 * quantities and notes (LF / 3.25% / green / Jamaican / sale only), and an
 * imported list prices exactly like the hand-built fixture basket.
 *
 * Run: npx jest __tests__/keep-import-planning.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseKeepList } from '../src/import/keep';
import { analyzeBasket, solvePlan, type BasketItem } from '../src/pricing/basket';
import { parseItemIntent } from '../src/pricing/intent';
import { BASKET, KEEP_CHECKLIST, buildOffers, fixtureContext } from './fixtures/waterdown-oct-2026';

describe('G. Keep import keeps what the planner needs', () => {
  const result = parseKeepList(KEEP_CHECKLIST);

  it('Costco and A1 Cash & Carry are headings, not groceries; the 11 product lines survive', () => {
    expect(result.headings).toEqual(expect.arrayContaining(['Costco', 'A1 Cash & Carry']));
    const names = result.items.map((i) => i.name);
    expect(names).not.toContain('Costco');
    expect(names).not.toContain('A1 Cash & Carry');
    expect(result.items).toHaveLength(11);
    expect(result.items.find((i) => i.name === 'Gummies')?.heading).toBe('Costco');
    expect(result.items.find((i) => i.name === 'Basmati rice')?.heading).toBe('A1 Cash & Carry');
  });

  it('LF, 3.25%, green, Jamaican and sale-only meaning reach the planner', () => {
    const byName = Object.fromEntries(result.items.map((i) => [i.name.toLowerCase(), i]));
    expect(parseItemIntent(byName['lf milk']).requiredTokens.sort()).toEqual(['lactosefree', 'milk', 'whole']);
    expect(parseItemIntent(byName['ketchup']).saleOnly).toBe(true);
    expect(parseItemIntent(byName['cascade pods']).saleOnly).toBe(true);
    expect(parseItemIntent(byName['jamaican patties']).hardAttributes).toEqual(['jamaican']);
    expect(parseItemIntent(byName['green seedless grapes']).hardAttributes).toEqual(['green', 'seedless']);
    // Store-heading notes add no product requirement
    expect(parseItemIntent(byName['gummies']).requiredTokens).toEqual(['gummy']);
  });

  it('an imported list prices like the fixture: $77.20 at ≤2 stores, $73.29 at ≤3', () => {
    const basket: BasketItem[] = result.items.map((it) => ({
      id: BASKET.find((b) => b.name.toLowerCase() === it.name.toLowerCase())!.id,
      name: it.name,
      quantity: it.quantity,
      unit: it.unit,
      notes: it.notes,
    }));
    const ctx = fixtureContext();
    const analysis = analyzeBasket(basket, buildOffers(), ctx);
    expect(solvePlan(analysis, 2, ctx).totalCents).toBe(7720);
    expect(solvePlan(analysis, 3, ctx).totalCents).toBe(7329);
    expect(solvePlan(analysis, 3, ctx).costedCount).toBe(10);
  });

  it('a repeated paste adds nothing', () => {
    const again = parseKeepList(KEEP_CHECKLIST, {
      existingItems: result.items.map((i) => ({ name: i.name, notes: i.notes })),
    });
    expect(again.items).toEqual([]);
  });
});
