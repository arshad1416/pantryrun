/**
 * Undo after deleting a list must bring the whole list back — items
 * included — and that restore must be saved and shared like any edit.
 *
 * deleteList used to call syncManager.unregisterList, which destroys the Yjs
 * doc. restoreList then wrote its "un-delete" flags into a brand-new empty doc
 * that had no id, name or items, so the list never reappeared and the undo
 * reached neither disk nor the family.
 */

import * as Y from 'yjs';
import sodium from 'libsodium-wrappers';
import { initCrypto } from '../src/crypto';
import { syncManager } from '../src/sync/sync-manager';
import { useListStore } from '../src/state/useListStore';
import { destroyAllDocs, extractItems, extractList, yjsAddItem } from '../src/sync/yjs-adapter';
import { loadListsFromDB, loadItemsFromDB } from '../src/storage/hydrate';
import type { GroceryItem } from '../src/types';

const { _resetDB } = require('@nozbe/watermelondb');
const key = new Uint8Array(32).fill(41);
const frames: any[] = [];

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { setImmediate(() => this.onopen?.()); }
  send(raw: string) { frames.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

function decrypt(frame: any): Uint8Array {
  const b = (v: string) => sodium.from_base64(v, sodium.base64_variants.ORIGINAL);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, new Uint8Array([...b(frame.payload.ciphertext), ...b(frame.payload.tag)]), frame.listId, b(frame.payload.iv), key);
}

function item(listId: string, name: string): GroceryItem {
  const now = Date.now();
  return { id: `${listId}-${name}`, listId, name, quantity: 1, unit: 'pcs', category: 'other', isChecked: false,
    isDeleted: false, deletedAt: null, version: 1, syncStatus: 'created', createdAt: now, updatedAt: now } as GroceryItem;
}

beforeEach(async () => {
  await syncManager.disconnect();
  destroyAllDocs();
  _resetDB();
  frames.length = 0;
  useListStore.setState({ lists: {} });
  await initCrypto();
  await sodium.ready;
  (globalThis as any).WebSocket = Socket;
});

afterEach(async () => {
  await syncManager.disconnect();
  destroyAllDocs();
  delete (globalThis as any).WebSocket;
});

it('undo restores the deleted list with its items, persisted and synced', async () => {
  await syncManager.hydrateFromDB(key);
  await syncManager.init({ url: 'ws://relay.test', familyId: 'fam', deviceId: 'dev', encryptionKey: key, allowUnauthenticated: true });
  await settle();

  const list = await useListStore.getState().createList('Weekend', 'fam');
  for (const name of ['apples', 'flour', 'yeast']) yjsAddItem(list.id, item(list.id, name));
  await settle();

  await useListStore.getState().deleteList(list.id);
  await settle();
  expect(useListStore.getState().lists[list.id]).toBeUndefined();

  await useListStore.getState().restoreList(list);
  await settle();

  // In memory: the list and every item are back.
  expect(useListStore.getState().lists[list.id]?.name).toBe('Weekend');
  expect(extractList(list.id)).toMatchObject({ name: 'Weekend', isDeleted: false });
  expect(extractItems(list.id).map((i) => i.name)).toEqual(['apples', 'flour', 'yeast']);

  // Survives a reload of the visible store (index + non-deleted).
  await useListStore.getState().loadLists();
  expect(useListStore.getState().lists[list.id]?.name).toBe('Weekend');

  // Persisted: the local database holds the restored, non-deleted list.
  const saved = (await loadListsFromDB(key)).find((l) => l.id === list.id);
  expect(saved).toMatchObject({ name: 'Weekend', isDeleted: false });
  expect((await loadItemsFromDB(key, { listIds: [list.id] })).length).toBe(3);

  // Synced: a peer applying everything this device published sees it restored.
  const peer = new Y.Doc();
  for (const frame of frames.filter((f) => f.type === 'update' && f.listId === list.id)) Y.applyUpdate(peer, decrypt(frame));
  expect(peer.getMap('meta').get('isDeleted')).toBe(false);
  expect(peer.getMap('meta').get('name')).toBe('Weekend');
  expect(peer.getArray('items').length).toBe(3);
  peer.destroy();
});

it('a deleted list stays hidden when its tombstoned history is replayed', async () => {
  await syncManager.hydrateFromDB(key);
  // The soft-deleted state as the relay replays it (or a peer sends it).
  const tombstone = new Y.Doc();
  const meta = tombstone.getMap('meta');
  meta.set('id', 'gone-list');
  meta.set('name', 'Gone');
  meta.set('familyId', 'fam');
  meta.set('isDeleted', true);
  meta.set('isActive', false);
  // Replay and hydration re-index every list they see, deleted or not.
  (syncManager as any).applyRemoteUpdate('gone-list', Y.encodeStateAsUpdate(tombstone));
  await useListStore.getState().loadLists();
  expect(useListStore.getState().lists['gone-list']).toBeUndefined();
  tombstone.destroy();
});
