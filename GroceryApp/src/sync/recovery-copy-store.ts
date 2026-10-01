/** Lossless, idempotent journal for an explicitly requested new shared list. */
import * as Y from 'yjs';
import { getDatabase } from '../storage/database';
import { decrypt, encrypt, encryptionKeyFingerprint, generateUUID } from '../crypto';
import type { GroceryItem, GroceryList, EncryptedData } from '../types';

export interface RecoveryCopyOperation {
  operationId: string;
  revision: string;
  capturedAt: number;
  phase: 'prepared' | 'ready';
  list: GroceryList;
  items: GroceryItem[];
  /** Exact new CRDT identities, reused on every retry and restart. */
  update: number[];
  itemIdMap: Record<string, string>;
  backup: {
    list: GroceryList;
    items: GroceryItem[];
    update: number[];
    listRows: unknown[];
    itemRows: unknown[];
    queueRows: Array<{ id: string; payload: string; raw: unknown; createdAt: number }>;
    envelopes: Record<string, EncryptedData | null>;
    rawEnvelopes: Record<string, string | null>;
    envelopeReadFailures: string[];
  };
}
interface RecoveryCopyBook { version: 1; operations: RecoveryCopyOperation[]; }
export interface RecoveryCopyOutboxEntry { sourceListId: string; operationId: string; targetListId: string; }
const bookContext = (scope: string, listId: string) => `yjs-recovery-copies:${scope}:${listId}`;
const outboxContext = (scope: string) => `yjs-recovery-copy-outbox:${scope}`;

export function recoveryCopyRevision(list: GroceryList, items: GroceryItem[]): string {
  const normalize = (value: any): any => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object') return Object.fromEntries(Object.keys(value)
      .filter(field => field !== 'syncStatus' && value[field] !== undefined && value[field] !== null)
      .sort().map(field => [field, normalize(value[field])]));
    return value;
  };
  return JSON.stringify(normalize({ list, items: [...items].sort((a, b) => a.id.localeCompare(b.id)) }));
}

async function readBook(scope: string, sourceListId: string, key: Uint8Array): Promise<RecoveryCopyBook> {
  const context = bookContext(scope, sourceListId);
  const envelope = await getDatabase().localStorage.get<EncryptedData>(context);
  if (!envelope) return { version: 1, operations: [] };
  const book = JSON.parse(await decrypt(envelope, key, context)) as RecoveryCopyBook;
  if (book?.version !== 1 || !Array.isArray(book.operations)) throw new Error('Unreadable saved recovery-copy journal');
  for (const operation of book.operations) {
    if (typeof operation.operationId !== 'string' || typeof operation.revision !== 'string' ||
      !operation.list?.id || operation.list.id === sourceListId || !Array.isArray(operation.items) ||
      !Array.isArray(operation.update) || operation.update.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
      !['prepared', 'ready'].includes(operation.phase)) throw new Error('Invalid saved recovery-copy operation');
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(operation.update));
      const entries = doc.getArray<Y.Map<any>>('items').toArray();
      if (doc.getMap('meta').get('id') !== operation.list.id || doc.store.pendingStructs || doc.store.pendingDs ||
        entries.length !== operation.items.length || entries.some(entry => !(entry instanceof Y.Map) || entry.get('listId') !== operation.list.id) ||
        new Set(entries.map(entry => entry.get('id'))).size !== entries.length) throw new Error('Invalid recovery-copy CRDT history');
    } finally { doc.destroy(); }
  }
  return book;
}
async function writeBook(scope: string, sourceListId: string, key: Uint8Array, book: RecoveryCopyBook): Promise<void> {
  const context = bookContext(scope, sourceListId);
  await getDatabase().localStorage.set(context, await encrypt(JSON.stringify(book), key, context));
}

export async function loadRecoveryCopyOutbox(key: Uint8Array): Promise<RecoveryCopyOutboxEntry[]> {
  const scope = await encryptionKeyFingerprint(key);
  const entries = await getDatabase().localStorage.get<RecoveryCopyOutboxEntry[]>(outboxContext(scope)) ?? [];
  if (!Array.isArray(entries) || entries.some(entry => !entry ||
    [entry.sourceListId, entry.operationId, entry.targetListId].some(value => typeof value !== 'string' || !value))) {
    throw new Error('Unreadable saved recovery-copy publication index');
  }
  return entries;
}

export async function loadRecoveryCopyOperation(entry: RecoveryCopyOutboxEntry, key: Uint8Array): Promise<RecoveryCopyOperation> {
  const scope = await encryptionKeyFingerprint(key);
  const operation = (await readBook(scope, entry.sourceListId, key)).operations.find(value => value.operationId === entry.operationId);
  if (!operation || operation.list.id !== entry.targetListId) throw new Error('Saved recovery-copy operation is missing');
  return operation;
}

/** Caller serializes this entire operation with ordinary snapshot/row writes. */
export async function prepareRecoveryCopy(source: { list: GroceryList; items: GroceryItem[]; update: Uint8Array; capturedAt: number }, key: Uint8Array, deviceId: string): Promise<RecoveryCopyOperation> {
  if (new Set(source.items.map(item => item.id)).size !== source.items.length) throw new Error('Saved list has conflicting item identities. Original data is preserved; a shared copy cannot be created safely.');
  const db = getDatabase();
  const scope = await encryptionKeyFingerprint(key);
  const book = await readBook(scope, source.list.id, key);
  const revision = recoveryCopyRevision(source.list, source.items);
  let operation = book.operations.find(value => value.revision === revision);
  if (!operation) {
    const targetId = await generateUUID();
    const itemIdMap: Record<string, string> = {};
    for (const item of source.items) itemIdMap[item.id] = await generateUUID();
    const label = deviceId.slice(-8) || 'local device';
    const list: GroceryList = { ...source.list, id: targetId, name: `Recovered copy — ${source.list.name} (${label})`,
      createdAt: source.capturedAt, updatedAt: source.capturedAt, version: 1, syncStatus: 'created' };
    const items = source.items.map(item => ({ ...item, id: itemIdMap[item.id], listId: targetId, syncStatus: 'created' as const }));
    const doc = new Y.Doc();
    let update: number[];
    try {
      doc.transact(() => {
        const meta = doc.getMap('meta');
        Object.entries(list).forEach(([field, value]) => meta.set(field, value));
        meta.set('description', list.description ?? '');
        meta.set('storePreference', list.storePreference ?? '');
        meta.set('recoverySourceListId', source.list.id);
        meta.set('recoverySourceDeviceId', deviceId);
        meta.set('recoveryCapturedAt', source.capturedAt);
        doc.getArray('items').push(items.map(item => { const entry = new Y.Map(); Object.entries(item).forEach(([field, value]) => entry.set(field, value)); return entry; }));
      });
      update = Array.from(Y.encodeStateAsUpdate(doc));
    } finally { doc.destroy(); }
    const listRows = (await db.get('grocery_lists').query().fetch()).filter(record => record.id === source.list.id);
    const itemRows = (await db.get('grocery_items').query().fetch()).filter(record => (record as any).listId === source.list.id);
    const queueRows = (await db.get('offline_queue').query().fetch()).filter(record => (record as any).listId === source.list.id)
      .map(record => ({ id: record.id, payload: (record as any).payload, raw: { ...(record as any)._raw }, createdAt: (record as any).createdAt }));
    const envelopes: Record<string, EncryptedData | null> = {};
    const rawEnvelopes: Record<string, string | null> = {};
    const envelopeReadFailures: string[] = [];
    for (const context of [`yjs-state:${source.list.id}`, `yjs-state:${scope}:${source.list.id}`, `yjs-local-recovery:${source.list.id}`, `yjs-local-recovery:${scope}:${source.list.id}`]) {
      rawEnvelopes[context] = await db.adapter.getLocal(context) ?? null;
      try { envelopes[context] = await db.localStorage.get<EncryptedData>(context) ?? null; }
      catch { envelopeReadFailures.push(context); }
    }
    operation = { operationId: targetId, revision, capturedAt: source.capturedAt, phase: 'prepared', list, items, update, itemIdMap,
      backup: { list: source.list, items: source.items, update: Array.from(source.update),
        listRows: listRows.map(record => ({ raw: { ...(record as any)._raw }, name: (record as any).name, description: (record as any).description, storePreference: (record as any).storePreference })),
        itemRows: itemRows.map(record => ({ raw: { ...(record as any)._raw }, name: (record as any).name, notes: (record as any).notes })), queueRows, envelopes, rawEnvelopes, envelopeReadFailures } };
    book.operations.push(operation);
    // One atomic encrypted value holds allocated app IDs AND exact new CRDT
    // bytes AND the complete backup, before any new list is saved or published.
    await writeBook(scope, source.list.id, key, book);
  }
  await holdRecoveryCopyQueue(operation);
  const outbox = await loadRecoveryCopyOutbox(key);
  if (!outbox.some(entry => entry.operationId === operation!.operationId)) {
    await db.localStorage.set(outboxContext(scope), [...outbox, { sourceListId: source.list.id, operationId: operation.operationId, targetListId: operation.list.id }]);
  }
  return operation;
}

export async function markRecoveryCopyReady(sourceListId: string, operationId: string, key: Uint8Array): Promise<void> {
  const scope = await encryptionKeyFingerprint(key);
  const book = await readBook(scope, sourceListId, key);
  const operation = book.operations.find(value => value.operationId === operationId);
  if (!operation) throw new Error('Recovery-copy journal is missing');
  operation.phase = 'ready';
  await writeBook(scope, sourceListId, key, book);
}

/** Discover a journal committed just before interruption of its outbox write. */
export async function repairRecoveryCopyOutbox(sourceIds: string[], key: Uint8Array, onError: (err: unknown) => void = () => {}): Promise<RecoveryCopyOutboxEntry[]> {
  const scope = await encryptionKeyFingerprint(key);
  const entries = await loadRecoveryCopyOutbox(key);
  let changed = false;
  for (const sourceId of sourceIds) {
    let book: RecoveryCopyBook;
    try { book = await readBook(scope, sourceId, key); } catch (err) { onError(err); continue; }
    for (const op of book.operations) if (!entries.some(entry => entry.operationId === op.operationId)) {
      entries.push({sourceListId: sourceId, operationId: op.operationId, targetListId: op.list.id});
      changed = true;
    }
  }
  if (changed) await getDatabase().localStorage.set(outboxContext(scope), entries);
  return entries;
}

/** Also repair this after an interruption between journal and queue hold. */
export async function holdRecoveryCopyQueue(operation: RecoveryCopyOperation): Promise<void> {
  const db = getDatabase();
  const held = await db.localStorage.get<string[]>('yjs-held-queue-ids') ?? [];
  if (!Array.isArray(held) || held.some(id => typeof id !== 'string')) throw new Error('Unreadable pending-change recovery index');
  await db.localStorage.set('yjs-held-queue-ids', [...new Set([...held, ...operation.backup.queueRows.map(row => row.id)])]);
}
