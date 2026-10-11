/**
 * Remote updates must not rewrite the whole list once per update.
 *
 * applyRemoteUpdate persisted after every update, and every persist encrypts
 * the full snapshot plus one row per item. A relay replay redelivers updates
 * this device already holds (every reconnect), and a cold start replays
 * hundreds: each one queued a full rewrite. Now an update that changes
 * nothing is not persisted, and writes coalesce per list.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as Y from 'yjs';
import { initCrypto } from '../src/crypto';
import { SyncManager } from '../src/sync/sync-manager';
import { destroyAllDocs, extractItems, extractList } from '../src/sync/yjs-adapter';
import { loadItemsFromDB, loadListsFromDB } from '../src/storage/hydrate';

const { _resetDB } = require('@nozbe/watermelondb');
const key = new Uint8Array(32).fill(23);

function sourceDoc(listId: string): Y.Doc {
  const doc = new Y.Doc();
  const meta = doc.getMap('meta');
  meta.set('id', listId);
  meta.set('name', 'Replayed');
  meta.set('familyId', 'fam');
  meta.set('isActive', true);
  meta.set('isDeleted', false);
  return doc;
}

function addItem(doc: Y.Doc, listId: string, n: number): void {
  const now = Date.now();
  const item = new Y.Map<any>();
  for (const [k, v] of Object.entries({ id: `${listId}-${n}`, listId, name: `item ${n}`, quantity: 1, unit: 'pcs',
    category: 'other', isChecked: false, isDeleted: false, deletedAt: null, version: 1, syncStatus: 'created',
    createdAt: now, updatedAt: now })) item.set(k, v);
  doc.getArray('items').push([item]);
}

let manager: SyncManager;
let writes: jest.SpiedFunction<any>;

beforeEach(async () => {
  destroyAllDocs();
  _resetDB();
  await initCrypto();
  manager = new SyncManager();
  await manager.hydrateFromDB(key);
  writes = jest.spyOn(manager as any, 'writeCapturedState');
});

afterEach(async () => {
  await manager.disconnect();
  destroyAllDocs();
  jest.restoreAllMocks();
});

const settle = () => Promise.allSettled([...(manager as any).pendingWrites]);

describe('remote update persistence', () => {
  it('a redelivered update that changes nothing is not persisted again', async () => {
    const src = sourceDoc('list-a');
    addItem(src, 'list-a', 1);
    const update = Y.encodeStateAsUpdate(src);

    (manager as any).applyRemoteUpdate('list-a', update);
    await settle();
    expect(writes).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 25; i++) (manager as any).applyRemoteUpdate('list-a', update);
    await settle();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(extractItems('list-a')).toHaveLength(1);
  });

  it('a delete-only update is still persisted', async () => {
    const src = sourceDoc('list-d');
    addItem(src, 'list-d', 1);
    addItem(src, 'list-d', 2);
    (manager as any).applyRemoteUpdate('list-d', Y.encodeStateAsUpdate(src));
    await settle();

    const before = Y.encodeStateVector(src);
    src.getArray('items').delete(0, 1);
    const deletion = Y.encodeStateAsUpdate(src, before);
    (manager as any).applyRemoteUpdate('list-d', deletion);
    await settle();

    expect(writes).toHaveBeenCalledTimes(2);
    const saved = await loadListsFromDB(key);
    expect(saved.find((l) => l.id === 'list-d')).toBeTruthy();
    // The snapshot written last holds the deletion.
    const snapshot = JSON.parse(writes.mock.calls[1][3] as string);
    const check = new Y.Doc();
    Y.applyUpdate(check, new Uint8Array(snapshot.update));
    expect(check.getArray('items').length).toBe(1);
    check.destroy();
  });

  it('a burst of distinct updates coalesces and the last write holds all of them', async () => {
    const src = sourceDoc('list-b');
    const updates: Uint8Array[] = [];
    src.on('update', (u: Uint8Array) => updates.push(u));
    for (let n = 0; n < 40; n++) addItem(src, 'list-b', n);
    // The meta writes happened before the listener; start with them.
    updates.unshift(Y.encodeStateAsUpdate(src, Y.encodeStateVector(new Y.Doc())));

    for (const u of updates) (manager as any).applyRemoteUpdate('list-b', u);
    await settle();

    expect(writes.mock.calls.length).toBeLessThanOrEqual(2);
    expect(extractList('list-b')?.name).toBe('Replayed');
    expect((await loadItemsFromDB(key, { listIds: ['list-b'] })).length).toBe(40);
  });
});
