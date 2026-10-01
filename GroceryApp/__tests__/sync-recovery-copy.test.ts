import * as Y from 'yjs';
import { initCrypto, decrypt } from '../src/crypto';
import { SyncManager } from '../src/sync/sync-manager';
import { getDatabase } from '../src/storage/database';
import { persistList, persistItem } from '../src/storage/hydrate';
import { saveQueueEntry, loadQueueEntries } from '../src/sync/offline-queue-store';
import { destroyAllDocs, extractItems, extractList, getDoc, yjsUpdateListMeta } from '../src/sync/yjs-adapter';
import { useSyncStore, syncIndicatorStatus } from '../src/state/useSyncStore';
import type { GroceryItem, GroceryList } from '../src/types';
const { _resetDB, _getTable }=require('@nozbe/watermelondb');
const key=new Uint8Array(32).fill(29);
const journalContext='yjs-recovery-copies:626d3fc43b48b31801d5e96fb8ff0619:legacy';
const frames:any[]=[];const managers:SyncManager[]=[];
class Socket {static OPEN=1;static CONNECTING=0;readyState=1;onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;constructor(){setImmediate(()=>this.onopen?.());}send(raw:string){frames.push(JSON.parse(raw));}close(){this.readyState=3;}}
const config={url:'ws://127.0.0.1:19997',familyId:'family',deviceId:'device-source-a',encryptionKey:key,allowUnauthenticated:true};
const source:GroceryList={id:'legacy',name:'Original saved groceries',description:'Keep this description',storePreference:'Local store',familyId:'family',isActive:true,isDeleted:false,deletedAt:null,version:3,syncStatus:'updated',createdAt:1,updatedAt:3};
const item=(id:string,changes:Partial<GroceryItem>={}):GroceryItem=>({id,listId:'legacy',familyId:'family',name:'Milk',quantity:2,unit:'L',category:'dairy',isChecked:true,addedBy:'original-device',assignedTo:'shopper',notes:'Keep these notes',sortOrder:1,isDeleted:false,deletedAt:null,version:4,syncStatus:'updated',createdAt:2,updatedAt:4,...changes});
const settle=async()=>{for(let i=0;i<20;i++)await new Promise<void>(r=>setImmediate(r));};
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};
const manager=()=>{const m=new SyncManager();managers.push(m);return m;};
async function prepare(){await persistList(source,key);await persistItem(item('milk'),key);await persistItem(item('deleted',{name:'Deleted eggs',isDeleted:true,deletedAt:5,isChecked:false,sortOrder:2}),key);const m=manager();await m.hydrateFromDB(key);await m.init(config);await settle();frames.length=0;return m;}
const create=(m:SyncManager)=>(m as any).createSharedRecoveryCopy('legacy') as Promise<GroceryList>;
async function readJournal(){const envelope=await getDatabase().localStorage.get<any>(journalContext);return JSON.parse(await decrypt(envelope,key,journalContext));}
beforeEach(async()=>{destroyAllDocs();_resetDB();frames.length=0;await initCrypto();(globalThis as any).WebSocket=Socket;useSyncStore.setState({persistenceError:null,storageRecoveryError:null,recoveryPendingLists:[],undecryptableLists:[],error:null});});
afterEach(async()=>{jest.restoreAllMocks();await Promise.all(managers.splice(0).map(m=>m.disconnect()));destroyAllDocs();delete (globalThis as any).WebSocket;});

it('creates a complete shared copy with fresh IDs, preserving originals, tombstones and held queue ciphertext',async()=>{
 const m=await prepare();const client=m.getClient()!;const queued=await saveQueueEntry('legacy',(client as any).encryptUpdate(new Uint8Array([0,0]),'legacy'),1);const oldQueue=await loadQueueEntries();
 const oldRows=JSON.parse(JSON.stringify([..._getTable('grocery_items').values()]));const oldList=extractList('legacy');const oldItems=extractItems('legacy');
 const copy=await create(m);await settle();expect(copy.id).not.toBe('legacy');expect(copy.name).toContain('Recovered copy');expect(copy.name).toContain('source-a');expect(copy.description).toBe('Keep this description');
 expect(extractList('legacy')).toEqual(oldList);expect(extractItems('legacy')).toEqual(oldItems);expect((await loadQueueEntries()).map(row=>row.id)).toEqual([queued]);expect(await loadQueueEntries()).toEqual(oldQueue);
 expect(JSON.parse(JSON.stringify(oldRows.map((row:any)=>_getTable('grocery_items').get(row.id))))).toEqual(oldRows);
 const journal=await readJournal();expect(journal.operations).toHaveLength(1);const operation=journal.operations[0];expect(operation.backup.queueRows[0].payload).toBe(JSON.stringify(oldQueue[0].payload));expect(operation.backup.items.map((value:any)=>value.id)).toEqual(['milk','deleted']);
 const frame=frames.find(f=>f.type==='update');expect(frame.listId).toBe(copy.id);expect(frames.filter(f=>f.type==='update'&&f.listId==='legacy')).toEqual([]);const peer=new Y.Doc();Y.applyUpdate(peer,(client as any).decryptUpdate(frame.payload,copy.id));
 const rows=peer.getArray<Y.Map<any>>('items').toArray().map(row=>row.toJSON());expect(rows).toHaveLength(2);expect(new Set(rows.map(row=>row.id)).size).toBe(2);expect(rows.every(row=>!['milk','deleted'].includes(row.id)&&row.listId===copy.id)).toBe(true);expect(rows.find(row=>row.name==='Deleted eggs')).toMatchObject({isDeleted:true,deletedAt:5});expect(rows.find(row=>row.name==='Milk')).toMatchObject({quantity:2,isChecked:true,notes:'Keep these notes',assignedTo:'shopper'});expect(peer.getMap('meta').get('recoverySourceListId')).toBe('legacy');peer.destroy();
});

it('double tap and later retry reuse one copy and the same CRDT structs',async()=>{
 const m=await prepare();const [first,second]=await Promise.all([create(m),create(m)]);const third=await create(m);await settle();expect(first.id).toBe(second.id);expect(third.id).toBe(first.id);expect((await readJournal()).operations).toHaveLength(1);
 const peer=new Y.Doc();const client=m.getClient()!;for(const frame of frames.filter(f=>f.type==='update'))Y.applyUpdate(peer,(client as any).decryptUpdate(frame.payload,first.id));expect(peer.getArray('items').length).toBe(2);expect(_getTable('grocery_lists').size).toBe(2);expect(_getTable('grocery_items').size).toBe(4);peer.destroy();
});

it('restarts an interrupted copy with its saved IDs and exact saved Yjs lineage, then publishes complete state',async()=>{
 const m=await prepare();const real=getDatabase().localStorage.set.bind(getDatabase().localStorage);let failed=false;
 const spy=jest.spyOn(getDatabase().localStorage,'set').mockImplementation(async(context:string,value:any)=>{if(context.startsWith('yjs-state:626d3fc43b48b31801d5e96fb8ff0619:')&&!context.endsWith(':legacy')&&!failed){failed=true;throw new Error('interrupted before copy snapshot');}return real(context,value);});
 await expect(create(m)).rejects.toThrow('interrupted');expect(frames.filter(f=>f.type==='update')).toEqual([]);const saved=(await readJournal()).operations[0];const savedId=saved.list.id;const peer=new Y.Doc();Y.applyUpdate(peer,new Uint8Array(saved.update));spy.mockRestore();await m.disconnect();destroyAllDocs();
 const restarted=manager();await restarted.hydrateFromDB(key);await restarted.init(config);await settle();expect(extractItems(savedId)).toHaveLength(2);expect(frames.filter(f=>f.type==='update'&&f.listId===savedId).length).toBeGreaterThan(0);const resumed=await create(restarted);expect(resumed.id).toBe(savedId);const client=restarted.getClient()!;for(const frame of frames.filter(f=>f.type==='update'))Y.applyUpdate(peer,(client as any).decryptUpdate(frame.payload,savedId));expect(peer.getArray('items').length).toBe(2);expect(extractItems(savedId)).toHaveLength(2);expect((await readJournal()).operations).toHaveLength(1);peer.destroy();
});

it('a failed encrypted backup prevents publication and leaves the source unchanged',async()=>{
 const m=await prepare();const before=extractItems('legacy');const real=getDatabase().localStorage.set.bind(getDatabase().localStorage);
 jest.spyOn(getDatabase().localStorage,'set').mockImplementation(async(context:string,value:any)=>{if(context===journalContext)throw new Error('backup storage unavailable');return real(context,value);});
 await expect(create(m)).rejects.toThrow('backup storage');expect(frames.filter(f=>f.type==='update')).toEqual([]);expect(extractItems('legacy')).toEqual(before);expect(_getTable('grocery_lists').size).toBe(1);
});

it('disconnect during copy preparation prevents stale publication and permits lossless resume',async()=>{
 const m=await prepare();const entered=deferred(),gate=deferred(),real=getDatabase().localStorage.set.bind(getDatabase().localStorage);
 const spy=jest.spyOn(getDatabase().localStorage,'set').mockImplementation(async(context:string,value:any)=>{if(context===journalContext){entered.release();await gate.promise;}return real(context,value);});
 const copying=create(m);const rejected=expect(copying).rejects.toThrow('session');await entered.promise;const stopping=m.disconnect();gate.release();await Promise.all([rejected,stopping]);expect(frames.filter(f=>f.type==='update')).toEqual([]);spy.mockRestore();destroyAllDocs();const savedId=(await readJournal()).operations[0].list.id;
 const resumed=manager();await resumed.hydrateFromDB(key);expect((await create(resumed)).id).toBe(savedId);expect(extractItems('legacy')).toHaveLength(2);expect(extractItems(savedId)).toHaveLength(2);
});

it('retains newer original edits when the user requested a copy of an earlier captured revision',async()=>{
 const m=await prepare();const entered=deferred(),gate=deferred(),real=getDatabase().localStorage.set.bind(getDatabase().localStorage);let first=true;
 jest.spyOn(getDatabase().localStorage,'set').mockImplementation(async(context:string,value:any)=>{if(context===journalContext&&first){first=false;entered.release();await gate.promise;}return real(context,value);});
 const copying=create(m);await entered.promise;yjsUpdateListMeta('legacy',{name:'Newer edit after tapping copy'});gate.release();const copy=await copying;await settle();expect(copy.name).toContain('Original saved groceries');expect(extractList('legacy')?.name).toBe('Newer edit after tapping copy');await m.disconnect();destroyAllDocs();const restarted=manager();await restarted.hydrateFromDB(key);expect(extractList('legacy')?.name).toBe('Newer edit after tapping copy');expect(extractList(copy.id)?.name).toContain('Original saved groceries');
});

it('automatically discovers a journal interrupted before its outbox and queue-hold commits',async()=>{
 const m=await prepare();await saveQueueEntry('legacy',(m.getClient() as any).encryptUpdate(new Uint8Array([0,0]),'legacy'),1);const real=getDatabase().localStorage.set.bind(getDatabase().localStorage);
 const spy=jest.spyOn(getDatabase().localStorage,'set').mockImplementation(async(context:string,value:any)=>{if(context==='yjs-held-queue-ids')throw new Error('interrupted after journal');return real(context,value);});
 await expect(create(m)).rejects.toThrow('interrupted');const saved=(await readJournal()).operations[0];spy.mockRestore();await m.disconnect();destroyAllDocs();frames.length=0;
 const restarted=manager();await restarted.hydrateFromDB(key);await restarted.init(config);await settle();expect(extractList(saved.list.id)?.id).toBe(saved.list.id);const frame=frames.find(f=>f.type==='update'&&f.listId===saved.list.id);expect(frame).toBeDefined();const peer=new Y.Doc();Y.applyUpdate(peer,new Uint8Array(saved.update));Y.applyUpdate(peer,(restarted.getClient() as any).decryptUpdate(frame.payload,saved.list.id));expect(peer.getArray('items').length).toBe(2);expect(await getDatabase().localStorage.get('yjs-held-queue-ids')).toEqual(expect.arrayContaining(saved.backup.queueRows.map((row:any)=>row.id)));peer.destroy();
});

it('preserves newer edits and deletion when retrying a ready copy after its doc was unregistered or restarted',async()=>{
 const m=await prepare();const copy=await create(m);yjsUpdateListMeta(copy.id,{name:'Later edited copy',isDeleted:true,isActive:false,deletedAt:999});m.unregisterList(copy.id);
 const retry=await create(m);expect(retry).toMatchObject({id:copy.id,name:'Later edited copy',isDeleted:true,deletedAt:999});await m.disconnect();destroyAllDocs();frames.length=0;const restarted=manager();await restarted.hydrateFromDB(key);await restarted.init(config);await settle();expect(extractList(copy.id)).toMatchObject({name:'Later edited copy',isDeleted:true,deletedAt:999});const peer=new Y.Doc();for(const frame of frames.filter(f=>f.type==='update'&&f.listId===copy.id))Y.applyUpdate(peer,(restarted.getClient() as any).decryptUpdate(frame.payload,copy.id));expect(peer.getMap('meta').get('isDeleted')).toBe(true);expect(peer.getArray('items').length).toBe(2);peer.destroy();
});

it('preserves malformed original envelope bytes in the encrypted backup',async()=>{
 const m=await prepare();const context='yjs-state:legacy';const real=getDatabase().localStorage.get.bind(getDatabase().localStorage);const rawSpy=jest.spyOn(getDatabase().adapter,'getLocal').mockResolvedValue('{broken original bytes');
 const spy=jest.spyOn(getDatabase().localStorage,'get').mockImplementation(async(value:string)=>{if(value===context)throw new SyntaxError('broken JSON');return real(value);});
 const copy=await create(m);const saved=(await readJournal()).operations[0];expect(saved.backup.rawEnvelopes[context]).toBe('{broken original bytes');expect(saved.backup.envelopeReadFailures).toContain(context);expect(copy.id).not.toBe('legacy');spy.mockRestore();rawSpy.mockRestore();
});

it('isolates an unreadable recovery-copy book while another completed copy still publishes discovery state',async()=>{
 const m=await prepare();const copy=await create(m);await m.disconnect();destroyAllDocs();frames.length=0;
 const registry='yjs-state-list-ids:626d3fc43b48b31801d5e96fb8ff0619';const saved=await getDatabase().localStorage.get<any>(registry);await getDatabase().localStorage.set(registry,{...saved,listIds:[...saved.listIds,'bad-source']});await getDatabase().localStorage.set('yjs-recovery-copies:626d3fc43b48b31801d5e96fb8ff0619:bad-source',{garbage:true});const restarted=manager();await restarted.hydrateFromDB(key);await restarted.init(config);await settle();expect(frames.some(f=>f.type==='update'&&f.listId===copy.id)).toBe(true);expect(useSyncStore.getState().storageRecoveryError).toBeTruthy();
});

it('shows paused sharing for the original and connected sharing for its healthy copy',async()=>{
 const m=await prepare();const copy=await create(m);await settle();const state={...useSyncStore.getState(),connectionState:'connected' as const};expect(syncIndicatorStatus({...state,activeListId:'legacy'}).label).toBe('Saved on this device — sharing paused');expect(syncIndicatorStatus({...state,activeListId:copy.id}).label).toBe('Connected');expect(syncIndicatorStatus({...state,activeListId:copy.id,persistenceError:"Couldn't save"}).label).toBe("Couldn't save");
});

it('refuses ambiguous duplicate source item identities while preserving the entire original',async()=>{
 const m=await prepare();const duplicate=new Y.Map<any>();Object.entries(item('milk',{name:'Conflicting duplicate'})).forEach(([k,v])=>duplicate.set(k,v));getDoc('legacy').getArray('items').push([duplicate]);await settle();const before=extractItems('legacy');await expect(create(m)).rejects.toThrow('conflicting item identities');expect(extractItems('legacy')).toEqual(before);expect(frames.filter(f=>f.type==='update')).toEqual([]);expect(await getDatabase().localStorage.get(journalContext)).toBeUndefined();
});

it('never rewinds a ready copy with corrupt latest history to its journal baseline',async()=>{
 const m=await prepare();const copy=await create(m);await m.disconnect();destroyAllDocs();const context=`yjs-state:626d3fc43b48b31801d5e96fb8ff0619:${copy.id}`;await getDatabase().localStorage.set(context,{corrupt:true});const restarted=manager();await restarted.hydrateFromDB(key);await restarted.init(config);await settle();frames.length=0;await expect(create(restarted)).rejects.toThrow('unreadable');expect(frames.filter(f=>f.type==='update'&&f.listId===copy.id)).toEqual([]);expect(await getDatabase().localStorage.get(context)).toEqual({corrupt:true});
});
