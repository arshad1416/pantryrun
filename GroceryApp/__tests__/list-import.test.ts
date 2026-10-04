/**
 * List import — pasted Keep checklists and Google Takeout Keep JSON.
 *
 * Run: npx jest __tests__/list-import.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseImport, parseKeepTakeout, parseListText } from '../src/services/list-import';

describe('parseListText', () => {
  it('reads checkbox markers and checked state', () => {
    const { items } = parseListText('☐ Milk\n☑ Bread\n- [x] Eggs\n- [ ] Butter\n• Jam');
    expect(items.map((i) => [i.name, i.checked])).toEqual([
      ['Milk', false], ['Bread', true], ['Eggs', true], ['Butter', false], ['Jam', false],
    ]);
  });

  it('store names and "Section:" lines are headings that set a store hint', () => {
    const { items, headings } = parseListText('Produce:\nApples\nCostco\n☐ Paper towels\n');
    expect(headings).toEqual(['Produce', 'Costco']);
    expect(items).toEqual([
      expect.objectContaining({ name: 'Apples', storeHint: 'Produce' }),
      expect.objectContaining({ name: 'Paper towels', storeHint: 'Costco' }),
    ]);
  });

  it('a product line with a colon inside is not a heading', () => {
    const { items } = parseListText('Note: buy the big one for the party next week please');
    expect(items).toHaveLength(1);
  });

  it('extra store names can be supplied', () => {
    expect(parseListText('Bulk Barn\nOats', { storeNames: ['Bulk Barn'] }).headings).toEqual(['Bulk Barn']);
  });

  it('splits notes and moves rule phrases out of the name', () => {
    const { items } = parseListText('Ketchup sale only\nRice (basmati)\nBread - any brand\nTea, sale only');
    expect(items.map((i) => [i.name, i.notes])).toEqual([
      ['Ketchup', 'sale only'],
      ['Rice', 'basmati'],
      ['Bread', 'any brand'],
      ['Tea', 'sale only'],
    ]);
  });

  it('reads an explicit quantity and flags an assumed one', () => {
    const { items } = parseListText('2 mangoes\n1.5 kg grapes\n3x yogurt\nCantaloupe');
    expect(items.map((i) => [i.name, i.quantity, i.unit, i.quantitySpecified])).toEqual([
      ['mangoes', 2, '', true],
      ['grapes', 1.5, 'kg', true],
      ['yogurt', 3, '', true],
      ['Cantaloupe', 1, '', false],
    ]);
  });

  it('keeps names that start with a number', () => {
    expect(parseListText('2% milk').items[0]).toMatchObject({ name: '2% milk', quantitySpecified: false });
  });
});

describe('parseKeepTakeout', () => {
  const note = JSON.stringify({
    title: 'Groceries',
    listContent: [
      { text: 'Fudgsicles', isChecked: false },
      { text: 'Costco', isChecked: false },
      { text: 'Elderberry gummies', isChecked: false },
      { text: 'Bananas', isChecked: true },
    ],
  });

  it('reads list items, checked state and headings', () => {
    const result = parseKeepTakeout(note)!;
    expect(result.title).toBe('Groceries');
    expect(result.headings).toEqual(['Costco']);
    expect(result.items.map((i) => [i.name, i.checked, i.storeHint])).toEqual([
      ['Fudgsicles', false, undefined],
      ['Elderberry gummies', false, 'Costco'],
      ['Bananas', true, 'Costco'],
    ]);
  });

  it('falls back to text content and rejects non-Keep JSON', () => {
    expect(parseKeepTakeout(JSON.stringify({ textContent: 'Milk\nEggs' }))!.items).toHaveLength(2);
    expect(parseKeepTakeout('{"foo": 1}')).toBeNull();
    expect(parseKeepTakeout('not json')).toBeNull();
  });

  it('parseImport picks JSON or text', () => {
    expect(parseImport(note).title).toBe('Groceries');
    expect(parseImport('Milk').items[0].name).toBe('Milk');
  });
});
