import * as Y from 'yjs';
import sodium from 'libsodium-wrappers';
import { initCrypto } from '../src/crypto';
import { syncManager, SyncManager } from '../src/sync/sync-manager';
import { useListStore } from '../src/state/useListStore';
import { destroyAllDocs, getDoc, yjsUpdateListMeta } from '../src/sync/yjs-adapter';
import { loadListsFromDB } from '../src/storage/hydrate';
import { syncIndicatorStatus } from '../src/state/useSyncStore';
const { _resetDB } = require('@nozbe/watermelondb');
const key = new Uint8Array(32).fill(27);
const frames: any[] = [];
class Socket {
  static OPEN = 1; static CONNECTING = 0;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { setImmediate(() => this.onopen?.()); }
  send(raw: string) { frames.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r)); };
beforeEach(async () => {
  syncManager.disconnect(); destroyAllDocs(); _resetDB(); frames.length = 0;
  useListStore.setState({ lists: {} });
  await initCrypto(); await sodium.ready;
  (globalThis as any).WebSocket = Socket;
});
afterEach(() => { syncManager.disconnect(); destroyAllDocs(); delete (globalThis as any).WebSocket; });

it('publishes and persists an empty new list before any item is added', async () => {
  await syncManager.hydrateFromDB(key);
  await syncManager.init({url: 'ws://127.0.0.1:19997', familyId:'fixture-family', deviceId:'fixture-a', encryptionKey:key, allowUnauthenticated:true});
  await settle();
  const list = await useListStore.getState().createList('Empty shared fixture', 'fixture-family');
  await settle();
  expect((await loadListsFromDB(key)).map(x => x.name)).toContain('Empty shared fixture');
  const frame = frames.find(x => x.type === 'update' && x.listId === list.id);
  expect(frame).toBeDefined();
  const ciphertext = sodium.from_base64(frame.payload.ciphertext, sodium.base64_variants.ORIGINAL);
  const tag = sodium.from_base64(frame.payload.tag, sodium.base64_variants.ORIGINAL);
  const combined = new Uint8Array([...ciphertext, ...tag]);
  const update = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, combined, list.id, sodium.from_base64(frame.payload.iv, sodium.base64_variants.ORIGINAL), key);
  const peer = new Y.Doc(); Y.applyUpdate(peer, update);
  expect(peer.getMap('meta').get('name')).toBe('Empty shared fixture');
  peer.destroy();
});

it('discovers a remote list in the visible index and observes subsequent local edits', async () => {
  const source = new Y.Doc(); source.getMap('meta').set('id', 'remote-fixture'); source.getMap('meta').set('name', 'Incoming fixture');
  source.getMap('meta').set('familyId', 'fixture-family');
  const receiver = new SyncManager(); await receiver.hydrateFromDB(key);
  await receiver.init({url:'ws://127.0.0.1:19997',familyId:'fixture-family',deviceId:'fixture-b',encryptionKey:key,allowUnauthenticated:true}, {onRemoteItemsUpdate: () => { useListStore.getState().loadLists(); }});
  await settle(); frames.length = 0;
  (receiver as any).applyRemoteUpdate('remote-fixture', Y.encodeStateAsUpdate(source));
  await settle();
  expect(frames.filter(x => x.type === 'update')).toHaveLength(0);
  expect(useListStore.getState().lists['remote-fixture']?.name).toBe('Incoming fixture');
  yjsUpdateListMeta('remote-fixture', {name: 'Edited remotely discovered fixture'});
  await settle();
  expect((await loadListsFromDB(key)).find(x => x.id==='remote-fixture')?.name).toBe('Edited remotely discovered fixture');
  expect(frames.some(x => x.type === 'update' && x.listId === 'remote-fixture')).toBe(true);
  const beforeRestartFrame = frames.find(x => x.type === 'update');
  const beforeCipher = sodium.from_base64(beforeRestartFrame.payload.ciphertext, sodium.base64_variants.ORIGINAL);
  const beforeTag = sodium.from_base64(beforeRestartFrame.payload.tag, sodium.base64_variants.ORIGINAL);
  Y.applyUpdate(source, sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, new Uint8Array([...beforeCipher,...beforeTag]), 'remote-fixture', sodium.from_base64(beforeRestartFrame.payload.iv, sodium.base64_variants.ORIGINAL), key));
  receiver.disconnect(); destroyAllDocs();
  const restarted = new SyncManager(); await restarted.hydrateFromDB(key);
  await useListStore.getState().loadLists();
  expect(useListStore.getState().lists['remote-fixture']?.name).toBe('Edited remotely discovered fixture');
  await restarted.init({url:'ws://127.0.0.1:19997',familyId:'fixture-family',deviceId:'fixture-b',encryptionKey:key,allowUnauthenticated:true});
  await settle(); frames.length = 0;
  yjsUpdateListMeta('remote-fixture', {name: 'Edit after restart'});
  await settle();
  const restartFrame = frames.find(x => x.type === 'update');
  const cipher = sodium.from_base64(restartFrame.payload.ciphertext, sodium.base64_variants.ORIGINAL);
  const tag = sodium.from_base64(restartFrame.payload.tag, sodium.base64_variants.ORIGINAL);
  const delta = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, new Uint8Array([...cipher,...tag]), 'remote-fixture', sodium.from_base64(restartFrame.payload.iv, sodium.base64_variants.ORIGINAL), key);
  Y.applyUpdate(source, delta);
  expect(source.getMap('meta').get('name')).toBe('Edit after restart');
  restarted.disconnect(); source.destroy();
});

it('describes an authenticated idle socket without promising recipient convergence', () => {
  expect(syncIndicatorStatus({syncState:'idle',error:null,undecryptableLists:[]}).label).toBe('Connected');
});
