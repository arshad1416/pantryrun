/**
 * A list nobody touches for 30 days must still reach a device that joins later.
 *
 * The relay ages stored updates out after 30 days and cannot read them to
 * build a replacement. Peers only answer sync requests for lists the asker
 * already knows, so once a quiet list's history expired, a newly paired
 * device never learned it existed.
 *
 * The fix: after the relay finishes replaying its history (history_complete),
 * each device publishes an encrypted full-state snapshot per list, flagged so
 * the relay replaces the entries it covers and never ages it out.
 *
 * The relay here models the real one's storage rules (relay-server/
 * encrypted-store.js): per-list seq, snapshot replaces entries with
 * seq <= coversSeq, retention keeps the latest snapshot and what follows it.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as Y from 'yjs';
import sodium from 'libsodium-wrappers';

jest.mock('../src/storage/hydrate', () => ({
  persistList: jest.fn(() => Promise.resolve()),
  persistItem: jest.fn(() => Promise.resolve()),
  loadItemsFromDB: jest.fn(() => Promise.resolve([])),
  loadListsFromDB: jest.fn(() => Promise.resolve([])),
}));

import { SyncManager } from '../src/sync/sync-manager';
import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { getDoc, destroyDoc } from '../src/sync/yjs-adapter';

const { _resetDB } = require('@nozbe/watermelondb') as any;

interface Stored { payload: any; seq: number; snapshot?: boolean; storedAt: number }

class ModelRelaySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static store = new Map<string, Stored[]>();
  static sockets: ModelRelaySocket[] = [];
  static nextSeq = 1;
  static now = 0;
  readyState = ModelRelaySocket.OPEN;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  joined = false;

  constructor(_url: string) {
    ModelRelaySocket.sockets.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }

  private reply(msg: any): void {
    const data = JSON.stringify(msg);
    setTimeout(() => this.onmessage?.({ data }), 0);
  }

  send(data: string): void {
    const msg = JSON.parse(data);
    if (msg.type === 'identity') {
      this.joined = true;
      for (const [listId, entries] of ModelRelaySocket.store) {
        for (const e of entries) {
          this.reply({ type: 'update', deviceId: 'stored-history', listId, payload: e.payload, seq: e.seq, snapshot: !!e.snapshot });
        }
      }
      this.reply({ type: 'history_complete' });
      return;
    }
    if (msg.type === 'update') {
      let entries = ModelRelaySocket.store.get(msg.listId) ?? [];
      const seq = ModelRelaySocket.nextSeq++;
      if (msg.snapshot === true) entries = entries.filter((e) => e.seq > (msg.coversSeq ?? 0));
      entries.push({ payload: msg.payload, seq, snapshot: msg.snapshot === true || undefined, storedAt: ModelRelaySocket.now });
      ModelRelaySocket.store.set(msg.listId, entries);
      for (const peer of ModelRelaySocket.sockets) {
        if (peer !== this && peer.joined && peer.readyState === ModelRelaySocket.OPEN) {
          peer.reply({ type: 'update', deviceId: msg.deviceId, listId: msg.listId, payload: msg.payload, seq });
        }
      }
      this.reply({ type: 'ack', message: 'Update relayed', msgId: msg.msgId, seq });
      return;
    }
    if (msg.type === 'sync_request') {
      for (const peer of ModelRelaySocket.sockets) {
        if (peer !== this && peer.joined && peer.readyState === ModelRelaySocket.OPEN) peer.reply(msg);
      }
    }
  }

  close(): void {
    this.readyState = ModelRelaySocket.CLOSED;
    ModelRelaySocket.sockets = ModelRelaySocket.sockets.filter((s) => s !== this);
  }

  /** The relay's retention sweep: superseded entries past the TTL go. */
  static ageOut(ttl: number): void {
    for (const [listId, entries] of ModelRelaySocket.store) {
      let protectedFrom = entries.length;
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].snapshot) { protectedFrom = i; break; }
      const kept = entries.filter((e, i) => i >= protectedFrom || ModelRelaySocket.now - e.storedAt < ttl);
      if (kept.length) ModelRelaySocket.store.set(listId, kept);
      else ModelRelaySocket.store.delete(listId);
    }
  }
}

const LIST_ID = 'quiet-list';
const DAY = 86_400_000;
const settle = () => new Promise((r) => setTimeout(r, 100));
let encryptionKey: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  encryptionKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  (globalThis as any).WebSocket = ModelRelaySocket;
});

afterAll(() => {
  delete (globalThis as any).WebSocket;
  destroyDoc(LIST_ID);
  _resetDB();
});

const config = (deviceId: string) => ({
  url: 'ws://relay.test', familyId: 'fam', deviceId, encryptionKey, allowUnauthenticated: true,
} as any);

describe('relay snapshots', () => {
  it('a list idle for longer than relay retention still reaches a newly joined device', async () => {
    // Device A creates a list with a few items while connected.
    const managerA = new SyncManager();
    await managerA.init(config('device-a'));
    await settle();
    managerA.registerList(LIST_ID);
    const doc = getDoc(LIST_ID);
    doc.transact(() => {
      const meta = doc.getMap('meta');
      meta.set('id', LIST_ID);
      meta.set('familyId', 'fam');
      meta.set('name', 'Cottage');
    });
    for (const name of ['milk', 'eggs', 'bread']) {
      const item = new Y.Map();
      item.set('id', name);
      item.set('listId', LIST_ID);
      item.set('name', name);
      doc.getArray('items').push([item]);
    }
    await settle();
    expect(ModelRelaySocket.store.get(LIST_ID)?.length).toBeGreaterThan(1);

    // A is reopened later (any reconnect): the replay ends, A snapshots the
    // list, and the relay replaces the entries the snapshot covers.
    ModelRelaySocket.sockets[0].readyState = ModelRelaySocket.CLOSED;
    ModelRelaySocket.sockets[0].onclose?.({});
    await new Promise((r) => setTimeout(r, 1500)); // first reconnect backoff
    await settle();
    const entries = ModelRelaySocket.store.get(LIST_ID) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].snapshot).toBe(true);
    await managerA.disconnect();

    // Nobody touches the list for 31 days; retention runs.
    ModelRelaySocket.now += 31 * DAY;
    ModelRelaySocket.ageOut(30 * DAY);

    // A new family device joins while A is offline.
    const docC = new Y.Doc();
    const clientC = new YjsWebSocketClient(config('device-c'));
    clientC.onRemoteUpdate = (listId, update) => { if (listId === LIST_ID) Y.applyUpdate(docC, update); };
    await clientC.init();
    await settle();

    expect(docC.getMap('meta').get('name')).toBe('Cottage');
    expect(docC.getArray<Y.Map<any>>('items').toArray().map((i) => i.get('name'))).toEqual(['milk', 'eggs', 'bread']);
    await clientC.disconnect();
  }, 20_000);
});
