/**
 * Checklist import — acceptance case G.
 *
 *  - Costco / A1 Cash & Carry are headings; context is kept; the 11 real
 *    product lines are recognised
 *  - checked state, quantities, notes, LF / green / Jamaican / sale-only
 *    meaning survive
 *  - ambiguous lines, duplicates, repeated imports and conflicting
 *    variants are flagged for review; nothing is merged or overwritten
 *  - the applied result is exactly the reviewed preview
 *
 * Run: npx jest __tests__/checklist-import.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildImport,
  emptyDecisions,
  parseChecklist,
  parseItemText,
  willImport,
  type ParsedLine,
} from '../src/services/checklistImport';
import { analyzeBasket, solvePlan, type BasketItem } from '../src/pricing/basket';
import { parseItemIntent } from '../src/pricing/intent';
import { BASKET, KEEP_CHECKLIST, buildOffers, fixtureContext } from './fixtures/waterdown-oct-2026';

const items = (lines: ParsedLine[]) => lines.filter((l) => l.kind === 'item');
const headings = (lines: ParsedLine[]) => lines.filter((l) => l.kind === 'heading');

describe('G. checklist import — headings and lines', () => {
  const lines = parseChecklist(KEEP_CHECKLIST);

  it('recognises Costco and A1 Cash & Carry as headings, not groceries', () => {
    expect(headings(lines).map((h) => h.name)).toEqual(['Groceries this week', 'Costco', 'A1 Cash & Carry']);
    expect(items(lines).map((i) => i.name)).not.toContain('Costco');
    expect(items(lines).map((i) => i.name)).not.toContain('A1 Cash & Carry');
  });

  it('keeps the 11 real product lines with section context', () => {
    expect(items(lines)).toHaveLength(11);
    expect(items(lines).find((i) => i.name === 'gummies')?.section).toBe('Costco');
    expect(items(lines).find((i) => i.name === 'basmati rice')?.section).toBe('A1 Cash & Carry');
    expect(items(lines).find((i) => i.name === 'bread')?.section).toBeUndefined(); // title is not a section
    const imported = buildImport(lines, emptyDecisions());
    expect(imported).toHaveLength(11);
    expect(imported.find((i) => i.name === 'gummies')?.notes).toBe('Section: Costco');
  });

  it('preserves explicit quantities, units and attached notes', () => {
    const byName = Object.fromEntries(items(lines).map((i) => [i.name, i]));
    expect(byName['LF milk']).toMatchObject({ quantity: 3, unit: 'L', notes: ['3.25% only'] });
    expect(byName['green seedless grapes']).toMatchObject({ quantity: 1.5, unit: 'kg' });
    expect(byName['baby carrots']).toMatchObject({ quantity: 500, unit: 'g' });
    expect(byName['eggs']).toMatchObject({ quantity: 1, unit: 'dozen' });
    expect(byName['ketchup']).toMatchObject({ notes: ['sale only'] });
    expect(byName['Cascade pods']).toMatchObject({ notes: ['sale only'] });
    expect(byName['Jamaican patties'].issues).toContain('quantity_assumed');
    // Each line keeps its source text
    expect(byName['LF milk'].source).toBe('☐ LF milk 3L (3.25% only)');
  });

  it('keeps LF / green / Jamaican / sale-only meaning, so the imported list prices like the fixture', () => {
    const imported = buildImport(lines, emptyDecisions());
    const milk = imported.find((i) => i.name === 'LF milk')!;
    expect(parseItemIntent(milk).requiredTokens.sort()).toEqual(['lactosefree', 'milk', 'whole']);
    expect(parseItemIntent(imported.find((i) => i.name === 'ketchup')!).saleOnly).toBe(true);
    expect(parseItemIntent(imported.find((i) => i.name === 'Jamaican patties')!).hardAttributes).toEqual(['jamaican']);
    expect(parseItemIntent(imported.find((i) => i.name === 'green seedless grapes')!).hardAttributes).toEqual(['green', 'seedless']);

    // Same plan as the hand-built fixture basket
    const basket: BasketItem[] = imported.map((it) => ({
      id: BASKET.find((b) => b.name === it.name)!.id,
      name: it.name, quantity: it.quantity, unit: it.unit, notes: it.notes,
    }));
    const ctx = fixtureContext();
    expect(solvePlan(analyzeBasket(basket, buildOffers(), ctx), 3, ctx).totalCents).toBe(7329);
    expect(solvePlan(analyzeBasket(basket, buildOffers(), ctx), 2, ctx).totalCents).toBe(7720);
  });

  it('preserves checked and unchecked state', () => {
    const parsed = parseChecklist('☐ milk\n☑ bread\n- [x] eggs\n- [ ] jam\n✔ tea');
    expect(items(parsed).map((i) => [i.name, i.checked])).toEqual([
      ['milk', false], ['bread', true], ['eggs', true], ['jam', false], ['tea', true],
    ]);
    expect(buildImport(parsed, emptyDecisions()).map((i) => i.isChecked)).toEqual([false, true, true, false, true]);
  });

  it('attaches indented and "note:" lines to the item above', () => {
    const parsed = parseChecklist('☐ patties\n    Jamaican, spicy\n☐ mayo\nnote: garlic only');
    expect(items(parsed).map((i) => i.notes)).toEqual([['Jamaican, spicy'], ['garlic only']]);
    expect(parseItemIntent({ name: 'mayo', notes: 'garlic only' }).requiredTokens).toContain('garlic');
  });
});

describe('G. checklist import — quantities', () => {
  it('missing quantity is a labelled assumption; invalid quantity is not imported; zero is preserved', () => {
    expect(parseItemText('bread')).toMatchObject({ quantity: 1, quantityAssumed: true });
    const parsed = parseChecklist('☐ milk x-2\n☐ jam x0\n☐ tea');
    const [milk, jam, tea] = items(parsed);
    expect(milk).toMatchObject({ quantity: null });
    expect(milk.issues).toContain('quantity_invalid');
    expect(willImport(milk, emptyDecisions())).toBe(false);
    expect(jam.quantity).toBe(0);
    expect(tea.issues).toContain('quantity_assumed');
  });

  it('reads leading and trailing counts', () => {
    expect(parseItemText('2 x avocados')).toMatchObject({ name: 'avocados', quantity: 2 });
    expect(parseItemText('3 lemons')).toMatchObject({ name: 'lemons', quantity: 3 });
    expect(parseItemText('limes ×4')).toMatchObject({ name: 'limes', quantity: 4 });
  });
});

describe('G. checklist import — review', () => {
  it('flags ambiguous lines; default heading, can be imported as an item', () => {
    const parsed = parseChecklist('Weekly\n☐ milk\nbananas\n☐ bread');
    const bananas = parsed.find((l) => l.name === 'bananas')!;
    expect(bananas.kind).toBe('heading');
    expect(bananas.issues).toContain('ambiguous_heading');
    expect(buildImport(parsed, emptyDecisions()).map((i) => i.name)).toEqual(['milk', 'bread']);
    const d = emptyDecisions();
    d.headingAsItem.add(bananas.lineNo);
    expect(buildImport(parsed, d).map((i) => i.name)).toEqual(['milk', 'bananas', 'bread']);
  });

  it('duplicate lines in one paste are skipped by default, never summed; "add anyway" is reversible', () => {
    const parsed = parseChecklist('☐ eggs\n☐ Eggs x2\n☐ bread');
    const dup = items(parsed)[1];
    expect(dup.issues).toContain('duplicate_in_paste');
    expect(dup.duplicateOf).toBe(1);
    const imported = buildImport(parsed, emptyDecisions());
    expect(imported.map((i) => [i.name, i.quantity])).toEqual([['eggs', 1], ['bread', 1]]);
    const d = emptyDecisions();
    d.addDuplicate.add(dup.lineNo);
    expect(buildImport(parsed, d)).toHaveLength(3);
    d.addDuplicate.delete(dup.lineNo);
    expect(buildImport(parsed, d)).toHaveLength(2);
  });

  it('a repeated paste does not double the list or overwrite it', () => {
    const first = buildImport(parseChecklist(KEEP_CHECKLIST), emptyDecisions());
    const existing = first.map((i) => ({ name: i.name, notes: i.notes }));
    const again = parseChecklist(KEEP_CHECKLIST, existing);
    expect(items(again).every((i) => i.issues.includes('already_on_list'))).toBe(true);
    expect(buildImport(again, emptyDecisions())).toEqual([]);
  });

  it('conflicting variants are flagged and kept separate, never merged', () => {
    const parsed = parseChecklist('☐ milk\n☐ milk (lactose-free only)\n☐ red grapes\n☐ green grapes');
    for (const l of items(parsed)) expect(l.issues).toContain('variant_conflict');
    expect(items(parsed).some((l) => l.duplicateOf !== undefined)).toBe(false);
    expect(buildImport(parsed, emptyDecisions())).toHaveLength(4);
  });

  it('an existing item with a different variant is not treated as a duplicate', () => {
    const parsed = parseChecklist('☐ LF milk', [{ name: 'milk' }]);
    expect(items(parsed)[0].issues).toEqual(expect.arrayContaining(['variant_conflict']));
    expect(items(parsed)[0].issues).not.toContain('already_on_list');
  });

  it('excluding a line removes exactly that line; the result matches the preview', () => {
    const parsed = parseChecklist(KEEP_CHECKLIST);
    const d = emptyDecisions();
    const ketchup = items(parsed).find((i) => i.name === 'ketchup')!;
    d.excluded.add(ketchup.lineNo);
    const result = buildImport(parsed, d);
    expect(result).toHaveLength(10);
    expect(result.map((r) => r.lineNo)).toEqual(items(parsed).filter((l) => willImport(l, d)).map((l) => l.lineNo));
  });

  it('plain lists without checkboxes import every line except named headings', () => {
    const parsed = parseChecklist('Costco:\npaper towels\nNo Frills\nmilk 2 L');
    expect(headings(parsed).map((h) => h.name)).toEqual(['Costco', 'No Frills']);
    expect(buildImport(parsed, emptyDecisions()).map((i) => [i.name, i.notes])).toEqual([
      ['paper towels', 'Section: Costco'],
      ['milk', 'Section: No Frills'],
    ]);
  });
});
