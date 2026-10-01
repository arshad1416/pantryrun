import * as Y from 'yjs';
import { initCrypto, encrypt, decrypt } from '../src/crypto';
import { SyncManager } from '../src/sync/sync-manager';
import { getDatabase } from '../src/storage/database';
import * as storage from '../src/storage/hydrate';
import { destroyAllDocs, extractItems, extractList, getDoc, hydrateList, yjsUpdateListMeta } from '../src/sync/yjs-adapter';
import type { GroceryList, GroceryItem } from '../src/types';
const { _resetDB } = require('@nozbe/watermelondb');
const key = new Uint8Array(32).fill(27);
const keyB = new Uint8Array(32).fill(28);
const managers: SyncManager[] = [];
const manager = () => { const m = new SyncManager(); managers.push(m); return m; };
const list = (id: string): GroceryList => ({ id, name: id, familyId: 'family', isActive: true, isDeleted: false, deletedAt: null, version: 1, syncStatus: 'created', createdAt: 1, updatedAt: 1 });
const item = (id: string): GroceryItem => ({ id: 'item-' + id, listId: id, familyId: 'family', name: 'Milk', quantity: 1, unit: 'L', category: 'dairy', isChecked: false, addedBy: 'device', sortOrder: 0, isDeleted: false, deletedAt: null, version: 1, syncStatus: 'created', createdAt: 1, updatedAt: 1 });
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise<void>(r => setImmediate(r)); };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
beforeEach(async () => { destroyAllDocs(); _resetDB(); await initCrypto(); });
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(managers.splice(0).map(m => m.disconnect())); destroyAllDocs(); });

it('isolates a corrupt snapshot and keeps healthy lists usable without overwriting the corrupt bytes', async () => {
  await storage.persistList(list('bad'), key); await storage.persistList(list('good'), key);
  await getDatabase().localStorage.set('yjs-state:bad', await encrypt('[999]', key, 'yjs-state:bad'));
  const original = await getDatabase().localStorage.get('yjs-state:bad');
  const m = manager(); await expect(m.hydrateFromDB(key)).resolves.toBeUndefined();
  expect(extractList('good')?.name).toBe('good');
  expect(extractList('bad')?.name).toBe('bad');
  yjsUpdateListMeta('bad', { name: 'Local rescue edit' }); await settle();
  expect(await getDatabase().localStorage.get('yjs-state:bad')).toEqual(original);
});

it('discovers a committed snapshot when a crash prevents the first list projection', async () => {
  const m = manager(); await m.hydrateFromDB(key);
  hydrateList('orphan', list('orphan'), [item('orphan')]);
  const spy = jest.spyOn(storage, 'persistList').mockRejectedValueOnce(new Error('simulated crash after snapshot'));
  await expect((m as any).persistListToDB('orphan')).rejects.toThrow('simulated crash');
  spy.mockRestore(); await m.disconnect(); destroyAllDocs();
  const restarted = manager(); await restarted.hydrateFromDB(key);
  expect(extractList('orphan')?.name).toBe('orphan');
  expect(extractItems('orphan').map(i => i.name)).toEqual(['Milk']);
});

it('serializes row projections with snapshots so an older delayed write cannot win', async () => {
  const m = manager(); await m.hydrateFromDB(key); hydrateList('ordered', list('ordered'), []);
  const firstEntered = deferred(); const gate = deferred(); const real = storage.persistList; let calls = 0;
  jest.spyOn(storage, 'persistList').mockImplementation(async (value, capturedKey) => {
    if (++calls === 1) { firstEntered.release(); await gate.promise; }
    return real(value, capturedKey);
  });
  const first = (m as any).persistListToDB('ordered'); await firstEntered.promise;
  yjsUpdateListMeta('ordered', { name: 'Newest' });
  const second = (m as any).persistListToDB('ordered'); await settle(); gate.release();
  await Promise.all([first, second]);
  expect((await storage.loadListsFromDB(key))[0].name).toBe('Newest');
});

it('drains captured-key writes before switching keys', async () => {
  const m = manager(); await m.hydrateFromDB(key); hydrateList('switch', list('switch'), [item('switch')]);
  const entered = deferred(); const gate = deferred(); const real = storage.persistList;
  jest.spyOn(storage, 'persistList').mockImplementation(async (value, capturedKey) => { entered.release(); await gate.promise; return real(value, capturedKey); });
  const write = (m as any).persistListToDB('switch'); await entered.promise;
  const switching = m.hydrateFromDB(keyB); await settle(); gate.release(); await Promise.all([write, switching]);
  expect((await storage.loadItemsFromDB(key)).map(i => i.name)).toEqual(['Milk']);
  expect(await storage.loadItemsFromDB(keyB)).toEqual([]);
});

it('disconnect drains in-flight storage before a reset and completes queued revisions', async () => {
  const m = manager(); await m.hydrateFromDB(key); hydrateList('wipe', list('wipe'), []);
  const entered = deferred(); const gate = deferred(); const real = storage.persistList;
  jest.spyOn(storage, 'persistList').mockImplementation(async (value, capturedKey) => { entered.release(); await gate.promise; return real(value, capturedKey); });
  const write = (m as any).persistListToDB('wipe'); await entered.promise;
  const pending = (m as any).persistListToDB('wipe');
  const stopping = m.disconnect(); let stopped = false; Promise.resolve(stopping).then(() => { stopped = true; });
  await settle(); expect(stopped).toBe(false); gate.release();
  await Promise.all([write, pending, stopping]);
  await getDatabase().write(async () => { await getDatabase().unsafeResetDatabase(); });
  await settle(); expect(await storage.loadListsFromDB(key)).toEqual([]);
});

it('never transmits synthetic legacy deltas or merges incoming history into reconstructed item arrays', async () => {
  await storage.persistList(list('legacy'), key); await storage.persistItem(item('legacy'), key);
  const original = new Y.Doc(); original.getMap('meta').set('id', 'legacy');
  const originalItem = new Y.Map(); Object.entries(item('legacy')).forEach(([k,v]) => originalItem.set(k,v)); original.getArray('items').push([originalItem]);
  const m = manager(); await m.hydrateFromDB(key);
  const outgoing: Uint8Array[] = []; (m as any).wsClient = { sendUpdate: (_id: string, update: Uint8Array) => outgoing.push(update), disconnect: () => {} };
  yjsUpdateListMeta('legacy', { name: 'Offline edit' }); await settle();
  expect(outgoing).toEqual([]);
  (m as any).applyRemoteUpdate('legacy', Y.encodeStateAsUpdate(original)); await settle();
  expect(extractList('legacy')?.name).toBe('Offline edit');
  expect(extractItems('legacy')).toHaveLength(1);
  expect(outgoing).toEqual([]); original.destroy();
});

it('preserves local rescue edits across restart without changing the corrupt original', async () => {
  await storage.persistList(list('rescue'), key);
  await getDatabase().localStorage.set('yjs-state:rescue', await encrypt('[999]', key, 'yjs-state:rescue'));
  const original = await getDatabase().localStorage.get('yjs-state:rescue');
  const m = manager(); await m.hydrateFromDB(key); yjsUpdateListMeta('rescue', { name: 'Rescued locally' }); await settle();
  await m.disconnect(); destroyAllDocs(); const restarted = manager(); await restarted.hydrateFromDB(key);
  expect(extractList('rescue')?.name).toBe('Rescued locally');
  expect(await getDatabase().localStorage.get('yjs-state:rescue')).toEqual(original);
});

it('retains healthy row-backed lists when the snapshot registry is corrupt', async () => {
  await storage.persistList(list('healthy'), key);
  await getDatabase().localStorage.set('yjs-state-list-ids', { corrupted: true });
  const m = manager(); await expect(m.hydrateFromDB(key)).resolves.toBeUndefined();
  expect(extractList('healthy')?.name).toBe('healthy');
  expect(await getDatabase().localStorage.get('yjs-state-list-ids')).toEqual({ corrupted: true });
});

it('evicts documents from the previous key before a new family can reconcile them', async () => {
  const m = manager(); await m.hydrateFromDB(key); hydrateList('old-private', list('old-private'), []);
  await m.hydrateFromDB(keyB);
  expect(extractList('old-private')).toBeNull();
});

it('keeps recovery visible through socket transitions, successful decrypt, and manual retry', async () => {
  const { useSyncStore, syncIndicatorStatus } = await import('../src/state/useSyncStore');
  await storage.persistList(list('pending'), key); const m = manager(); await m.hydrateFromDB(key); await settle();
  useSyncStore.getState().setConnectionState('connected'); useSyncStore.getState().noteDecryptOk('pending');
  useSyncStore.getState().markSynced();
  expect(syncIndicatorStatus(useSyncStore.getState()).label).toContain('recovery');
  useSyncStore.getState().setSyncState('not_configured');
  expect(syncIndicatorStatus(useSyncStore.getState()).label).toContain('recovery');
});

it('drains the newest accepted revision on ordinary disconnect before restart', async () => {
  const m = manager(); await m.hydrateFromDB(key); hydrateList('latest', list('latest'), []);
  const entered = deferred(); const gate = deferred(); const real = storage.persistList; let calls = 0;
  jest.spyOn(storage, 'persistList').mockImplementation(async (value, capturedKey) => { if (++calls === 1) { entered.release(); await gate.promise; } return real(value, capturedKey); });
  const first = (m as any).persistListToDB('latest'); await entered.promise;
  yjsUpdateListMeta('latest', { name: 'Accepted newest edit' }); const second = (m as any).persistListToDB('latest');
  const stopping = m.disconnect(); gate.release(); await Promise.all([first, second, stopping]); destroyAllDocs();
  const restarted = manager(); await restarted.hydrateFromDB(key);
  expect(extractList('latest')?.name).toBe('Accepted newest edit');
});

it('retains incomplete remote lineage over restart and heals when its missing baseline arrives', async () => {
  const source = new Y.Doc(); let baseline!: Uint8Array; let delta!: Uint8Array;
  source.on('update', bytes => { if (!baseline) baseline = bytes; else delta = bytes; });
  source.transact(() => { source.getMap('meta').set('id', 'out-of-order'); source.getMap('meta').set('name', 'First'); });
  source.getMap('meta').set('name', 'Second');
  const m = manager(); await m.hydrateFromDB(key); (m as any).applyRemoteUpdate('out-of-order', delta); await settle();
  await m.disconnect(); destroyAllDocs(); const restarted = manager(); await restarted.hydrateFromDB(key);
  (restarted as any).applyRemoteUpdate('out-of-order', baseline); await settle();
  expect(extractList('out-of-order')?.name).toBe('Second'); source.destroy();
});

it('keeps row-backed lists usable when the registry read fails to parse malformed JSON', async () => {
  await storage.persistList(list('parsed-healthy'), key);
  const real=getDatabase().localStorage.get.bind(getDatabase().localStorage);
  jest.spyOn(getDatabase().localStorage,'get').mockImplementation(async (context: string) => { if(context==='yjs-state-list-ids')throw new SyntaxError('malformed persisted JSON');return real(context); });
  const m=manager();await expect(m.hydrateFromDB(key)).resolves.toBeUndefined();expect(extractList('parsed-healthy')?.name).toBe('parsed-healthy');
});

it('does not quarantine old-key-only snapshots as current-family recovery failures', async () => {
  const m=manager();await m.hydrateFromDB(key);hydrateList('old-key-list',list('old-key-list'),[]);await (m as any).persistListToDB('old-key-list');
  await m.hydrateFromDB(keyB);await settle();const {useSyncStore}=await import('../src/state/useSyncStore');
  expect(useSyncStore.getState().recoveryPendingLists).toEqual([]);expect(extractList('old-key-list')).toBeNull();
  hydrateList('new-key-list',list('new-key-list'),[]);await (m as any).persistListToDB('new-key-list');await m.hydrateFromDB(key);await settle();
  expect(extractList('old-key-list')?.name).toBe('old-key-list');expect(extractList('new-key-list')).toBeNull();
});

it('scopes snapshots by key so normal family changes show no storage-recovery warning', async () => {
  const m=manager();await m.hydrateFromDB(key);hydrateList('scoped',list('scoped'),[]);await (m as any).persistListToDB('scoped');
  await m.hydrateFromDB(keyB);await settle();const {useSyncStore}=await import('../src/state/useSyncStore');
  expect(useSyncStore.getState().storageRecoveryError).toBeNull();
  hydrateList('scoped',{...list('scoped'),name:'Different family with same application ID'},[]);await (m as any).persistListToDB('scoped');
  await m.hydrateFromDB(key);expect(extractList('scoped')?.name).toBe('scoped');
  await m.hydrateFromDB(keyB);expect(extractList('scoped')?.name).toBe('Different family with same application ID');
});

it('imports readable legacy snapshots losslessly while leaving old encrypted originals intact', async () => {
  hydrateList('legacy-snapshot',list('legacy-snapshot'),[]);const envelope=await encrypt(JSON.stringify(Array.from(Y.encodeStateAsUpdate(getDoc('legacy-snapshot')))),key,'yjs-state:legacy-snapshot');destroyAllDocs();
  await getDatabase().localStorage.set('yjs-state:legacy-snapshot',envelope);await getDatabase().localStorage.set('yjs-state-list-ids',['legacy-snapshot']);
  const m=manager();await m.hydrateFromDB(key);expect(extractList('legacy-snapshot')?.name).toBe('legacy-snapshot');
  expect(await getDatabase().localStorage.get('yjs-state:legacy-snapshot')).toEqual(envelope);
  expect(await getDatabase().localStorage.get('yjs-state:c90d1cd40ae34ef919aa7640d08ed0cd:legacy-snapshot')).toBeDefined();
  expect(await getDatabase().localStorage.get('yjs-state-list-ids')).toEqual(['legacy-snapshot']);
});

it('reports corruption of a current-key scoped orphan without hiding healthy lists', async () => {
  const m=manager();await m.hydrateFromDB(key);hydrateList('bad-orphan',list('bad-orphan'),[]);await (m as any).persistListToDB('bad-orphan');
  const context='yjs-state:c90d1cd40ae34ef919aa7640d08ed0cd:bad-orphan';await getDatabase().localStorage.set(context,await encrypt('[999]',key,context));
  const { _getTable }=require('@nozbe/watermelondb');_getTable('grocery_lists').clear();await storage.persistList(list('still-healthy'),key);
  await m.hydrateFromDB(key);await settle();const {useSyncStore}=await import('../src/state/useSyncStore');
  expect(extractList('still-healthy')?.name).toBe('still-healthy');expect(useSyncStore.getState().storageRecoveryError).toContain('history');
});

it('a failed local save remains visible when wire decrypt and legacy recovery are also failing', async () => {
  const {syncIndicatorStatus}=await import('../src/state/useSyncStore');
  const result=syncIndicatorStatus({syncState:'idle',error:null,undecryptableLists:['other'],recoveryPendingLists:['legacy'],persistenceError:"Couldn't save recent changes to this device",storageRecoveryError:'History unavailable'});
  expect(result.label).toBe("Couldn't save recent changes to this device");
});

it('persists edits to a restored list while another list is still being imported', async () => {
  await storage.persistList(list('first-restored'),key);await storage.persistList(list('second-restored'),key);
  const entered=deferred(),gate=deferred(),real=storage.persistList;
  jest.spyOn(storage,'persistList').mockImplementation(async (value,capturedKey)=>{if(value.id==='second-restored'){entered.release();await gate.promise;}return real(value,capturedKey);});
  const m=manager();const hydrating=m.hydrateFromDB(key);await entered.promise;yjsUpdateListMeta('first-restored',{name:'Edited during other import'});gate.release();await hydrating;await m.disconnect();destroyAllDocs();
  const restarted=manager();await restarted.hydrateFromDB(key);expect(extractList('first-restored')?.name).toBe('Edited during other import');
});
