import { canHydrateField, createSubmitGate, dirtyItemChanges, requireEditTarget, stepItemQuantity, type EditableItemField, type ItemDraft } from '../src/utils/itemEditDraft';
import type { GroceryItem } from '../src/types';

const draft: ItemDraft = { name: 'My draft', quantity: 3, unit: 'kg', category: 'produce', notes: undefined };
const fields: EditableItemField[] = ['name', 'quantity', 'unit', 'category', 'notes'];

describe('item editing during sync', () => {
  test('all 32 dirty-field combinations preserve typed fields and write only those fields', () => {
    for (let mask = 0; mask < 32; mask++) {
      const dirty = new Set(fields.filter((_, i) => mask & (1 << i)));
      const changes = dirtyItemChanges(draft, dirty);
      for (const field of fields) {
        expect(canHydrateField(field, dirty)).toBe(!dirty.has(field));
        expect(Object.prototype.hasOwnProperty.call(changes, field)).toBe(dirty.has(field));
        if (dirty.has(field)) expect(changes[field]).toBe(draft[field]);
      }
    }
  });
  test('cleared notes remain an explicit changed field, not an untouched omission', () => {
    expect(dirtyItemChanges(draft, new Set(['notes']))).toEqual({ notes: undefined });
  });
  test('missing, remotely deleted, and wrong-list edit targets never become a new item', () => {
    const item = { id: 'item', listId: 'list', isDeleted: false } as GroceryItem;
    expect(requireEditTarget(item, 'list')).toBe(item);
    expect(() => requireEditTarget(undefined, 'list')).toThrow('no longer available');
    expect(() => requireEditTarget({ ...item, isDeleted: true }, 'list')).toThrow('no longer available');
    expect(() => requireEditTarget(item, 'other')).toThrow('no longer available');
  });
});

describe('same-frame submit gate', () => {
  test('keyboard and button bursts produce one pending mutation; completion or failure allows retry', async () => {
    const gate = createSubmitGate();
    let complete!: () => void;
    let calls = 0;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    async function submit() {
      if (!gate.begin()) return;
      try { calls++; await pending; } finally { gate.end(); }
    }
    const attempts = Array.from({ length: 1000 }, submit);
    expect(calls).toBe(1);
    expect(gate.pending).toBe(true); // cancel/new-modal handlers must refuse until settled
    complete();
    await Promise.all(attempts);
    expect(gate.pending).toBe(false);
    expect(gate.begin()).toBe(true);
    gate.end();
    expect(gate.begin()).toBe(true);
  });
});

 test('quantity stepper remains finite and bounded at unsafe edges', () => {
  expect(stepItemQuantity(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(stepItemQuantity(1, -1)).toBe(1);
  for (const q of [0, -1, Infinity, -Infinity, NaN, 1e100, Number.MAX_SAFE_INTEGER, 0.5, 42]) {
    for (const d of [-1, 1] as const) {
      const next = stepItemQuantity(q, d);
      expect(Number.isFinite(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(1);
      expect(next).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  }
});
