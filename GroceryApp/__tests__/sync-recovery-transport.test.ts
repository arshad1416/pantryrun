import * as Y from 'yjs';
import { initCrypto } from '../src/crypto';
import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { SyncManager } from '../src/sync/sync-manager';
import { getDatabase } from '../src/storage/database';
import * as queue from '../src/sync/offline-queue-store';
import { persistList, persistItem } from '../src/storage/hydrate';
import { destroyAllDocs, getDoc, extractList, extractItems, hydrateList, yjsUpdateListMeta } from '../src/sync/yjs-adapter';
import type { GroceryList, GroceryItem } from '../src/types';
const { _resetDB } = require('@nozbe/watermelondb');
const key = new Uint8Array(32).fill(29);
const frames: any[] = [];
const clients: Array<YjsWebSocketClient | SyncManager> = [];
class Socket {
  static OPEN = 1; static CONNECTING = 0; readyState = 1;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor() { setImmediate(() => this.onopen?.()); } send(raw: string) { frames.push(JSON.parse(raw)); } close() { this.readyState = 3; }
}
const config = { url: 'ws://127.0.0.1:19997', familyId: 'family', deviceId: 'device', encryptionKey: key, allowUnauthenticated: true };
const list: GroceryList = { id: 'legacy', name: 'Groceries', familyId: 'family', isActive: true, isDeleted: false, deletedAt: null, version: 1, syncStatus: 'created', createdAt: 1, updatedAt: 1 };
const item: GroceryItem = { id: 'milk', listId: 'legacy', familyId: 'family', name: 'Milk', quantity: 1, unit: 'L', category: 'dairy', isChecked: false, addedBy: 'device', sortOrder: 0, isDeleted: false, deletedAt: null, version: 1, syncStatus: 'created', createdAt: 1, updatedAt: 1 };
const settle = async () => { for (let i=0;i<15;i++) await new Promise<void>(r => setImmediate(r)); };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
beforeEach(async () => { destroyAllDocs(); _resetDB(); frames.length=0; await initCrypto(); (globalThis as any).WebSocket = Socket; });
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(clients.splice(0).map(c => c.disconnect())); destroyAllDocs(); delete (globalThis as any).WebSocket; });

it('disconnect waits for in-flight offline queue storage before reset', async () => {
  const c = new YjsWebSocketClient(config); clients.push(c); await c.init(); await settle();
  const entered=deferred(), gate=deferred(), real=queue.saveQueueEntry;
  jest.spyOn(queue,'saveQueueEntry').mockImplementation(async (...args) => { entered.release(); await gate.promise; return real(...args); });
  (c as any).state='disconnected'; c.sendUpdate('some-list', new Uint8Array([0,0])); await entered.promise;
  let stopped=false; const stopping=Promise.resolve(c.disconnect()).then(() => { stopped=true; });
  await settle(); expect(stopped).toBe(false); gate.release(); await stopping;
  await getDatabase().write(async () => { await getDatabase().unsafeResetDatabase(); }); await settle();
  expect(await queue.loadQueueEntries()).toEqual([]);
});

it('does not reconnect when a delayed queue restore finishes after disconnect', async () => {
  const c = new YjsWebSocketClient(config); clients.push(c);
  const entered=deferred(), gate=deferred(); jest.spyOn(queue,'loadQueueEntries').mockImplementation(async () => { entered.release(); await gate.promise; return []; });
  const initializing=c.init(); await entered.promise; const stopping=c.disconnect(); gate.release(); await Promise.all([initializing,stopping]); await settle();
  expect(frames).toEqual([]);
});

it('holds old legacy queue entries durably instead of publishing or discarding them', async () => {
  const sealing=new YjsWebSocketClient(config); clients.push(sealing); await sealing.init(); await settle();
  const id=await queue.saveQueueEntry('legacy', (sealing as any).encryptUpdate(new Uint8Array([0,0]), 'legacy'), 1); await sealing.disconnect(); frames.length=0;
  const held=new YjsWebSocketClient({...config,canSendList: id => id!=='legacy'}); clients.push(held); await held.init(); await settle();
  expect(frames.filter(f => f.type==='update')).toEqual([]);
  expect((await queue.loadQueueEntries()).map(x => x.id)).toEqual([id]);
  await held.disconnect(); frames.length=0;
  const next=new YjsWebSocketClient(config); clients.push(next); await next.init(); await settle();
  expect(frames.filter(f => f.type==='update')).toEqual([]);
  expect((await queue.loadQueueEntries()).map(x => x.id)).toEqual([id]);
});

it('adopts only a complete equal original history and future deltas converge without duplicate items', async () => {
  hydrateList('legacy',list,[item]); const source=getDoc('legacy'); const originalBytes=Y.encodeStateAsUpdate(source); const originalVector=Y.encodeStateVector(source); const peer=new Y.Doc(); Y.applyUpdate(peer,originalBytes);
  await persistList(list,key); await persistItem(item,key); destroyAllDocs();
  const m=new SyncManager(); clients.push(m); await m.hydrateFromDB(key); await m.init(config); await settle();
  const client=m.getClient()!; const request=frames.find(f => f.type==='recovery_request'); expect(request).toBeDefined();
  const requestData=JSON.parse(Buffer.from((client as any).decryptUpdate(request.payload,'legacy')).toString());
  const reply={kind:'complete-crdt-recovery',listId:'legacy',senderDeviceId:'peer',targetDeviceId:'device',requestId:requestData.requestId,update:Array.from(originalBytes)};
  await (client as any).handleMessage({type:'recovery_response',listId:'legacy',deviceId:'peer',payload:(client as any).encryptUpdate(new Uint8Array(Buffer.from(JSON.stringify(reply))),'legacy')}); await settle();
  expect(Array.from(Y.encodeStateVector(getDoc('legacy')))).toEqual(Array.from(originalVector));
  expect(await getDatabase().localStorage.get('yjs-legacy-backup:legacy')).toBeDefined();
  frames.length=0; yjsUpdateListMeta('legacy',{name:'Shared after recovery'}); await settle();
  const outgoing=frames.find(f => f.type==='update'); expect(outgoing).toBeDefined(); Y.applyUpdate(peer,(client as any).decryptUpdate(outgoing.payload,'legacy'));
  expect(peer.getMap('meta').get('name')).toBe('Shared after recovery'); expect(peer.getArray('items').length).toBe(1); peer.destroy();
});

it('retains divergent legacy local edits and tombstones after a completed peer recovery response', async () => {
  hydrateList('legacy',list,[item]); const baseline=Y.encodeStateAsUpdate(getDoc('legacy')); destroyAllDocs();
  await persistList({...list,name:'Local offline rename'},key); await persistItem({...item,isDeleted:true,deletedAt:4},key);
  const m=new SyncManager(); clients.push(m); await m.hydrateFromDB(key); await m.init(config); await settle();
  const client=m.getClient()!; const request=frames.find(f => f.type==='recovery_request'); expect(request).toBeDefined();
  const requestData=JSON.parse(Buffer.from((client as any).decryptUpdate(request.payload,'legacy')).toString());
  await (client as any).handleMessage({type:'recovery_response',listId:'legacy',deviceId:'peer',payload:(client as any).encryptUpdate(new Uint8Array(Buffer.from(JSON.stringify({kind:'complete-crdt-recovery',listId:'legacy',senderDeviceId:'peer',targetDeviceId:'device',requestId:requestData.requestId,update:Array.from(baseline)}))),'legacy')}); await settle();
  expect(extractList('legacy')?.name).toBe('Local offline rename'); expect(extractItems('legacy')).toHaveLength(1); expect(extractItems('legacy')[0].isDeleted).toBe(true);
  expect(frames.filter(f => f.type==='update')).toEqual([]);
});

it('asks for reconciliation after adoption so edits made during backup are not missed', async () => {
  hydrateList('legacy',list,[item]);const peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(getDoc('legacy')));const baseline=Y.encodeStateAsUpdate(peer);destroyAllDocs();
  await persistList(list,key);await persistItem(item,key);const m=new SyncManager();clients.push(m);await m.hydrateFromDB(key);await m.init(config);await settle();
  const client=m.getClient()!;const request=frames.find(f=>f.type==='recovery_request');const value=JSON.parse(Buffer.from((client as any).decryptUpdate(request.payload,'legacy')).toString());
  const gate=deferred(),entered=deferred(),real=getDatabase().localStorage.set.bind(getDatabase().localStorage);
  jest.spyOn(getDatabase().localStorage,'set').mockImplementation(async (context:string,data:any)=>{if(context==='yjs-legacy-backup:legacy'){entered.release();await gate.promise;}return real(context,data);});
  const reply={kind:'complete-crdt-recovery',listId:'legacy',senderDeviceId:'peer',targetDeviceId:'device',requestId:value.requestId,update:Array.from(baseline)};
  await (client as any).handleMessage({type:'recovery_response',listId:'legacy',deviceId:'peer',payload:(client as any).encryptUpdate(new Uint8Array(Buffer.from(JSON.stringify(reply))),'legacy')});await entered.promise;
  const before=Y.encodeStateVector(peer);peer.getMap('meta').set('name','Peer edit during backup');(m as any).applyRemoteUpdate('legacy',Y.encodeStateAsUpdate(peer,before));gate.release();await settle();
  const reconcile=frames.find(f=>f.type==='sync_request');expect(reconcile).toBeDefined();const vector=(client as any).decryptUpdate(reconcile.payload,'legacy');(m as any).applyRemoteUpdate('legacy',Y.encodeStateAsUpdate(peer,vector));await settle();
  expect(extractList('legacy')?.name).toBe('Peer edit during backup');expect(extractItems('legacy')).toHaveLength(1);peer.destroy();
});

it('a bootstrap canceled during credential lookup cannot reconnect after reset', async () => {
  const {syncManager}=await import('../src/sync/sync-manager');await syncManager.disconnect();
  const crypto=await import('../src/crypto'),enroll=await import('../src/identity/enroll');const gate=deferred(),entered=deferred();
  jest.spyOn(crypto,'getMasterKey').mockResolvedValue(key);jest.spyOn(enroll,'getRelayToken').mockImplementation(async()=>{entered.release();await gate.promise;return 'old-token';});
  const {bootstrapSync}=await import('../src/sync/bootstrap');const booting=bootstrapSync();await entered.promise;await syncManager.disconnect();gate.release();
  expect(await booting).toBe('cancelled');await settle();expect(frames).toEqual([]);expect(syncManager.getClient()).toBeNull();
});
