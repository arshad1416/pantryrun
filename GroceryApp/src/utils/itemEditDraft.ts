import type { GroceryItem } from '../types';

export type EditableItemField = 'name' | 'quantity' | 'unit' | 'category' | 'notes';
export type ItemDraft = Pick<GroceryItem, EditableItemField>;

export function canHydrateField(field: EditableItemField, dirty: ReadonlySet<EditableItemField>): boolean {
  return !dirty.has(field);
}

/** Do not write untouched fields back over newer family-sync changes. */
export function dirtyItemChanges(draft: ItemDraft, dirty: ReadonlySet<EditableItemField>): Partial<ItemDraft> {
  const changes: Partial<ItemDraft> = {};
  for (const field of dirty) Object.assign(changes, { [field]: draft[field] });
  return changes;
}

/** A vanished/deleted edit target must never become a new-item request. */
export function requireEditTarget(item: GroceryItem | undefined, listId: string): GroceryItem {
  if (!item || item.isDeleted || item.listId !== listId) {
    throw new Error('This item is no longer available. Go back to the list and refresh.');
  }
  return item;
}

/** State renders are asynchronous: synchronously reject duplicate submits. */
export function createSubmitGate() {
  let pending = false;
  return {
    get pending() { return pending; },
    begin() { if (pending) return false; pending = true; return true; },
    end() { pending = false; },
  };
}

export function stepItemQuantity(quantity: number, delta: 1 | -1): number {
  const current = Number.isFinite(quantity) ? quantity : 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, current + delta));
}
