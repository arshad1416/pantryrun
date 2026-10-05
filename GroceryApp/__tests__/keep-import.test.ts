/**
 * Google Keep import — parseKeepList / parseListLine.
 *
 * Covers Keep's copied-text format (title, ☐/☑ markers), other list
 * markers, Takeout JSON, store and section headings, quantities, notes,
 * ticked items, duplicates and items already on the list.
 *
 * Run: npx jest __tests__/keep-import.test.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { parseKeepList, parseListLine, MAX_IMPORT_ITEMS } from '../src/import/keep';
import { parseItemIntent as parseItemConstraints } from '../src/pricing/intent';

const names = (r: ReturnType<typeof parseKeepList>) => r.items.map((i) => i.name);

describe('parseListLine — written quantities', () => {
  it.each([
    ['2 bananas', 'Bananas', 2, 'each'],
    ['2x bananas', 'Bananas', 2, 'each'],
    ['2 x bananas', 'Bananas', 2, 'each'],
    ['eggs x2', 'Eggs', 2, 'each'],
    ['12 eggs', 'Eggs', 12, 'each'],
    ['a dozen eggs', 'Eggs', 12, 'each'],
    ['2L milk', 'Milk', 2, 'L'],
    ['milk 2L', 'Milk', 2, 'L'],
    ['1 kg chicken thighs', 'Chicken thighs', 1, 'kg'],
    ['500g flour', 'Flour', 500, 'g'],
    ['2 bags of coffee beans', 'Coffee beans', 2, 'bag'],
    ['coffee beans - 2 bags', 'Coffee beans', 2, 'bag'],
    ['Coke Zero 12 pack', 'Coke Zero', 12, 'pack'],
  ])('%s → %s × %d %s', (line, name, quantity, unit) => {
    expect(parseListLine(line)).toEqual({ name, quantity, unit });
  });

  it.each([
    ['2% milk'],
    ['Get Real cereal'],
    ['Vitamin B12'],
    ['Lux soap'],
    ['green grapes'],
  ])('keeps "%s" whole with quantity 1', (line) => {
    const parsed = parseListLine(line);
    expect(parsed.name.toLowerCase()).toBe(line.toLowerCase());
    expect(parsed.quantity).toBe(1);
  });
});

describe('parseKeepList — Keep copied text', () => {
  const pasted = [
    'Groceries',
    '☐ green grapes',
    '☐ milk (lactose free)',
    '☑ bread',
    '☐ 2 bananas',
  ].join('\n');

  it('takes the first unmarked line as the title', () => {
    const r = parseKeepList(pasted);
    expect(r.title).toBe('Groceries');
    expect(names(r)).toEqual(['Green grapes', 'Milk', 'Bananas']);
  });

  it('skips ticked items by default and reports them', () => {
    const r = parseKeepList(pasted);
    expect(r.skipped).toEqual([{ text: 'bread', reason: 'ticked' }]);
  });

  it('imports ticked items when asked', () => {
    const r = parseKeepList(pasted, { includeChecked: true });
    expect(r.items.find((i) => i.name === 'Bread')?.checked).toBe(true);
  });

  it('turns parentheses into notes the planner enforces', () => {
    const milk = parseKeepList(pasted).items.find((i) => i.name === 'Milk')!;
    expect(milk.notes).toBe('lactose free');
  });

  it('keeps a counted parenthetical as the quantity', () => {
    expect(parseKeepList('☐ bananas (3)').items[0]).toMatchObject({ name: 'Bananas', quantity: 3 });
  });

  it.each([
    ['[ ] milk\n[x] eggs'],
    ['- milk\n- eggs'],
    ['* milk\n* eggs'],
    ['• milk\n• eggs'],
    ['1. milk\n2. eggs'],
    ['milk\neggs'],
  ])('accepts other list markers: %j', (text) => {
    expect(names(parseKeepList(text, { includeChecked: true }))).toEqual(['Milk', 'Eggs']);
  });

  it('a plain list with no markers has no title — every line is an item', () => {
    const r = parseKeepList('milk\neggs\nbread');
    expect(r.title).toBeUndefined();
    expect(r.items).toHaveLength(3);
  });

  it('ignores blank lines, links and emoji-only lines', () => {
    const r = parseKeepList('☐ milk\n\n☐ https://example.com/recipe\n☐ 🛒\n☐ eggs');
    expect(names(r)).toEqual(['Milk', 'Eggs']);
    expect(r.skipped.map((s) => s.reason)).toEqual(['not_an_item', 'not_an_item']);
  });
});

describe('parseKeepList — store headings', () => {
  const pasted = [
    'Weekly shop',
    'Costco:',
    '☐ paper towels',
    '☐ eggs x2',
    '— No Frills —',
    '☐ green grapes',
    '☐ Fortinos',
    '☐ Jamaican patties (sale only)',
    'Produce:',
    '☐ spinach',
  ].join('\n');
  const r = parseKeepList(pasted);

  it('never imports a heading as an item', () => {
    expect(names(r)).toEqual(['Paper towels', 'Eggs', 'Green grapes', 'Jamaican patties', 'Spinach']);
    expect(r.headings).toEqual(['Costco', 'No Frills', 'Fortinos', 'Produce']);
  });

  it('notes the store an item was listed under', () => {
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(byName['Paper towels'].notes).toBe('From: Costco list');
    expect(byName['Green grapes'].notes).toBe('From: No Frills list');
    expect(byName['Green grapes'].heading).toBe('No Frills');
  });

  it('a bare known store name, even ticked-box style, is a heading', () => {
    expect(r.items.find((i) => i.name === 'Jamaican patties')?.notes)
      .toBe('From: Fortinos list · sale only');
  });

  it('non-store headings are sections, not stores', () => {
    expect(r.items.find((i) => i.name === 'Spinach')?.notes).toBe('Section: Produce');
  });

  it('heading notes do not trip the planner\'s note constraints', () => {
    const c = parseItemConstraints({ name: 'Paper towels', notes: 'From: Costco list' });
    expect(c.noteTokens).toEqual([]);
    expect(c.saleOnly).toBe(false);
    const patties = parseItemConstraints({ name: 'Jamaican patties', notes: 'From: Fortinos list · sale only' });
    expect(patties.saleOnly).toBe(true);
    expect(patties.noteTokens).toEqual([]);
  });

  it.each([['## Metro'], ['== Metro =='], ['METRO'], ['Metro list'], ['FreshCo:'], ["Longo's"]])(
    'recognises %j as a store heading',
    (heading) => {
      const res = parseKeepList(`${heading}\n- milk`);
      expect(res.headings).toEqual([expect.any(String)]);
      expect(res.items[0].notes).toMatch(/^From: .+ list$/);
    },
  );

  it('an item that merely ends in a colon under a checkbox is still an item', () => {
    expect(names(parseKeepList('☐ cheese: old cheddar\n☐ milk'))).toEqual(['Cheese: old cheddar', 'Milk']);
  });
});

describe('parseKeepList — Takeout JSON', () => {
  it('reads a list note', () => {
    const note = JSON.stringify({
      title: 'Groceries',
      isTrashed: false,
      listContent: [
        { text: 'Costco:', isChecked: false },
        { text: 'eggs x2', isChecked: false },
        { text: 'bread', isChecked: true },
      ],
    });
    const r = parseKeepList(note);
    expect(r.title).toBe('Groceries');
    expect(r.items).toEqual([
      { name: 'Eggs', quantity: 2, unit: 'each', checked: false, notes: 'From: Costco list', heading: 'Costco' },
    ]);
    expect(r.skipped).toEqual([{ text: 'bread', reason: 'ticked' }]);
  });

  it('reads a text note line by line', () => {
    const note = JSON.stringify({ title: 'Shop', textContent: 'milk\n2 bananas' });
    expect(names(parseKeepList(note))).toEqual(['Milk', 'Bananas']);
  });

  it('falls back to text for JSON-looking input that is not a note', () => {
    expect(names(parseKeepList('{not json'))).toEqual(['{not json']);
  });
});

describe('parseKeepList — duplicates', () => {
  it('skips repeats within the paste', () => {
    const r = parseKeepList('- milk\n- Milk\n- eggs');
    expect(names(r)).toEqual(['Milk', 'Eggs']);
    expect(r.skipped).toEqual([{ text: 'Milk', reason: 'duplicate' }]);
  });

  it('skips items already on the list', () => {
    const r = parseKeepList('- milk\n- eggs', { existingNames: ['MILK'] });
    expect(names(r)).toEqual(['Eggs']);
    expect(r.skipped).toEqual([{ text: 'milk', reason: 'already_on_list' }]);
  });

  it(`caps an import at ${MAX_IMPORT_ITEMS} items`, () => {
    const many = Array.from({ length: MAX_IMPORT_ITEMS + 50 }, (_, i) => `- item ${String.fromCharCode(97 + (i % 26))}${i}`);
    expect(parseKeepList(many.join('\n')).items).toHaveLength(MAX_IMPORT_ITEMS);
  });
});

// ─── addItem({ silent }) — bulk import doesn't notify per item ─────────────

const mockSendFamilyNotification = jest.fn(async () => {});
jest.mock('../src/notifications/NotificationManager', () => ({
  sendFamilyNotification: mockSendFamilyNotification,
}));
jest.mock('../src/sync/yjs-adapter', () => ({
  extractItems: jest.fn(),
  yjsAddItem: jest.fn(),
  yjsUpdateItem: jest.fn(),
  yjsBatchUpdate: jest.fn(),
  yjsDeleteItem: jest.fn(),
  yjsClaimItem: jest.fn(),
  yjsUnclaimItem: jest.fn(),
  getListMeta: () => new Map([['name', 'Groceries']]),
}));
jest.mock('../src/sync/sync-manager', () => ({
  syncManager: { getEncryptionKey: () => new Uint8Array(32), registerList: jest.fn() },
}));
jest.mock('../src/identity/device', () => ({ getDeviceId: async () => 'device-1' }));
jest.mock('../src/crypto', () => {
  let n = 0;
  return { generateUUID: async () => `id-${++n}` };
});

describe('useGroceryStore.addItem — silent option', () => {
  const base = {
    listId: 'list-1',
    familyId: 'fam-1',
    quantity: 1,
    unit: 'each',
    category: 'other' as const,
    isChecked: false,
    addedBy: 'me',
    sortOrder: 1,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockSendFamilyNotification.mockClear();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('notifies the family for a normal add', async () => {
    const { useGroceryStore } = await import('../src/state/useGroceryStore');
    await useGroceryStore.getState().addItem({ ...base, name: 'Milk' });
    expect(mockSendFamilyNotification).toHaveBeenCalledTimes(1);
  });

  it('stays silent for an imported item', async () => {
    const { useGroceryStore } = await import('../src/state/useGroceryStore');
    const item = await useGroceryStore.getState().addItem({ ...base, name: 'Eggs' }, { silent: true });
    expect(mockSendFamilyNotification).not.toHaveBeenCalled();
    expect(useGroceryStore.getState().items[item.id]?.name).toBe('Eggs');
  });
});
