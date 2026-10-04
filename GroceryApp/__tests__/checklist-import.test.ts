/**
 * Checklist import preview — exit gate: a realistic Keep checklist imports
 * with the right unchecked items and constraints, zero accidental heading
 * items, and explicit review of every uncertainty.
 */

import { describe, it, expect } from '@jest/globals';
import { previewImport, itemsToAdd, refreshPreview, describeIntent } from '../src/import/checklist-import';
import { planBasket } from '../src/pricing/basket-planner';
import { KEEP_PASTE, STORE_NAMES, NOW, WINDOW } from './fixtures/pinned-basket';

describe('previewImport on a Keep-style checklist', () => {
  const preview = previewImport(KEEP_PASTE);
  const items = preview.entries.filter((e) => e.kind === 'item');

  it('headings (title, Costco, A1 Cash & Carry) never become items', () => {
    const headings = preview.entries.filter((e) => e.kind === 'heading').map((e) => e.name);
    expect(headings).toEqual(['Groceries', 'Costco', 'A1 Cash & Carry']);
    const added = itemsToAdd(preview.entries).map((i) => i.name.toLowerCase());
    for (const h of ['groceries', 'costco', 'a1 cash & carry']) expect(added).not.toContain(h);
  });

  it('preserves checkbox state; checked lines default to skip', () => {
    const napkins = items.find((e) => e.name === 'napkins')!;
    expect(napkins.checked).toBe(true);
    expect(napkins.action).toBe('skip');
    expect(items.filter((e) => !e.checked).map((e) => e.name)).toEqual([
      'GREEN grapes', 'whole lactose-free milk', 'JAMAICAN patties', 'ketchup', 'yogurt tubes',
      'cheddar cheese', 'basmati rice', 'chicken thighs', 'grapes', 'red grapes',
    ]);
  });

  it('keeps written quantities and units; missing quantities stay unknown and are flagged', () => {
    const byName = Object.fromEntries(items.map((e) => [e.name, e]));
    expect(byName['GREEN grapes']).toMatchObject({ quantity: 1.5, unit: 'kg' });
    expect(byName['whole lactose-free milk']).toMatchObject({ quantity: 2, unit: 'L' });
    expect(byName['JAMAICAN patties']).toMatchObject({ quantity: 8, unit: 'ea' });
    expect(byName['cheddar cheese']).toMatchObject({ quantity: 500, unit: 'g' });
    expect(byName['basmati rice']!.quantity).toBeNull();
    expect(byName['basmati rice']!.flags[0]).toMatch(/no quantity written/);
  });

  it('keeps notes and constraints: sale-only, "for kids" as a note, variants as requirements', () => {
    const byName = Object.fromEntries(items.map((e) => [e.name, e]));
    expect(byName.ketchup!.notes).toBe('sale only');
    expect(describeIntent(byName.ketchup!)).toContain('sale only');
    expect(describeIntent(byName['yogurt tubes']!)).toEqual(['note: for kids']);
    expect(describeIntent(byName['GREEN grapes']!)).toEqual(['must be GREEN']);
    expect(describeIntent(byName['whole lactose-free milk']!)).toEqual(['must be WHOLE, LACTOSE-FREE']);
  });

  it('store headings become hints, not stops', () => {
    const cheese = items.find((e) => e.name === 'cheddar cheese')!;
    expect(cheese.storeHint).toBe('Costco');
    expect(itemsToAdd(preview.entries).find((i) => i.name === 'cheddar cheese')!.notes).toBe('store hint: Costco');
  });

  it('conflicting variants are flagged and kept separate, never combined', () => {
    const grapes = items.filter((e) => /grapes/.test(e.name));
    expect(grapes).toHaveLength(3);
    for (const g of grapes) expect(g.flags.some((f) => /conflicting variants/.test(f))).toBe(true);
  });

  it('import is blocked until every flagged "add" line is reviewed', () => {
    expect(preview.needsReview).toBeGreaterThan(0);
    const reviewed = preview.entries.map((e) => ({ ...e, reviewed: true }));
    expect(refreshPreview(reviewed).needsReview).toBe(0);
  });
});

describe('duplicates', () => {
  it('a repeated import does not double count lines already on the list', () => {
    const first = previewImport('☐ eggs x12\n☐ bread');
    const existing = itemsToAdd(first.entries).map((i, n) => ({ id: `e${n}`, name: i.name, isChecked: false }));
    const again = previewImport('☐ eggs x12\n☐ bread', existing);
    expect(again.toAdd).toBe(0);
    expect(again.entries.every((e) => e.flags.some((f) => /already on your list/.test(f)))).toBe(true);
  });

  it('a line repeated in the paste is skipped with a reason', () => {
    const p = previewImport('☐ milk 2 L\n☐ milk 2 L');
    expect(p.entries.map((e) => e.action)).toEqual(['add', 'skip']);
    expect(p.entries[1]!.flags[0]).toMatch(/repeats line 1/);
  });
});

describe('ambiguous lines', () => {
  it('a plain line in the middle of a checklist is ambiguous and skipped until chosen', () => {
    const p = previewImport('☐ eggs x12\nremember coupons\n☐ bread');
    const amb = p.entries.find((e) => e.kind === 'ambiguous')!;
    expect(amb.raw).toBe('remember coupons');
    expect(amb.action).toBe('skip');
  });

  it('a plain bulleted list (no checkboxes) imports every line as an unchecked item', () => {
    const p = previewImport('- eggs x12\n- 2 L milk\nCostco:\n- rice 8 kg');
    expect(p.entries.map((e) => [e.kind, e.name])).toEqual([
      ['item', 'eggs'], ['item', 'milk'], ['heading', 'Costco'], ['item', 'rice'],
    ]);
  });
});

describe('import → planner end to end', () => {
  it('imported lines are planned with the same rules; missing quantities are labelled assumptions', () => {
    const p = previewImport(KEEP_PASTE);
    const added = itemsToAdd(p.entries).map((i, n) => ({ id: `i${n}`, ...i }));
    const plan = planBasket(added, {}, STORE_NAMES, 3, { window: WINDOW, now: NOW });
    const rice = plan.lines.find((l) => l.line.rawText === 'basmati rice')!;
    expect(rice.line.quantitySource).toBe('assumed');
    const ketchup = plan.lines.find((l) => l.line.rawText === 'ketchup')!;
    expect(ketchup.line.saleOnly).toBe(true);
    // No prices supplied: everything is held, nothing is priced at $0.
    expect(plan.proposals).toEqual([]);
    expect(plan.held).toHaveLength(added.length);
  });
});
