/**
 * H10 — full-state reconciliation over the relay.
 *
 * Before this, a client had no way to ask "what did I miss?". Every drop path
 * in the system was therefore permanent rather than eventually reconciled:
 * the offline queue evicting its oldest entry at MAX_QUEUE_SIZE, an
 * undecryptable row deleted on restore, a relay volume wipe, plain TTL expiry.
 *
 * The fix is the handshake Yjs is built for. On (re)connect a client sends its
 * per-document state vector (`Y.encodeStateVector`) as an encrypted
 * `sync_request`; any peer that receives one answers with
 * `Y.encodeStateAsUpdate(doc, theirStateVector)` — the exact delta they lack —
 * over the ordinary `update` message. The relay only has to broadcast the new
 * message type; it stays blind to the contents, which are sealed in the same
 * XChaCha20-Poly1305 envelope (AAD = listId) as every other payload.
 *
 * This test reproduces the queue-eviction loss end to end and then recovers
 * from it.
 *
 * Run: npx jest __tests__/sync-reconciliation.test.ts
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
import { YjsWebSocketClient, MAX_QUEUE_SIZE } from '../src/sync/y-websocket';
import { getDoc, destroyDoc } from '../src/sync/yjs-adapter';

const { _resetDB } = require('@nozbe/watermelondb') as any;

// ─── In-memory relay ─────────────────────────────────────────────────────────
// Broadcasts every non-handshake frame to the other connected sockets, which
// is all the real relay does with `update` / `notification` payloads.

class HubWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** When false a new socket never opens — the client stays offline and queues. */
  static accepting = true;
  static peers: HubWebSocket[] = [];
  static log: any[] = [];

  readyState: number = HubWebSocket.CLOSED;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;

  constructor(_url: string) {
    if (!HubWebSocket.accepting) return; // stays CLOSED, no onopen
    this.readyState = HubWebSocket.OPEN;
    HubWebSocket.peers.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(data: string): void {
    const msg = JSON.parse(data);
    HubWebSocket.log.push(msg);
    if (msg.type === 'auth' || msg.type === 'identity') return;
    for (const peer of HubWebSocket.peers) {
      if (peer !== this && peer.readyState === HubWebSocket.OPEN) {
        setTimeout(() => peer.onmessage?.({ data }), 0);
      }
    }
  }

  close(): void {
    this.readyState = HubWebSocket.CLOSED;
    HubWebSocket.peers = HubWebSocket.peers.filter((p) => p !== this);
  }
}

const LIST_ID = 'list-reconcile';
const settle = () => new Promise((r) => setTimeout(r, 150));

let encryptionKey: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  encryptionKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  (globalThis as any).WebSocket = HubWebSocket;
});

afterAll(() => {
  delete (globalThis as any).WebSocket;
  destroyDoc(LIST_ID);
  _resetDB();
});

function makeConfig(deviceId: string) {
  return {
    url: 'ws://localhost:9998',
    familyId: 'fam-reconcile',
    deviceId,
    encryptionKey,
    allowUnauthenticated: true,
  } as any;
}

describe('a state-vector handshake recovers an update evicted from the offline queue', () => {
  it('loses the oldest queued update, then reconciles it back', async () => {
    destroyDoc(LIST_ID);
    const docA = getDoc(LIST_ID);
    const docB = new Y.Doc(); // the peer's independent replica

    // ─── Phase 1: device A is offline and overruns its queue ───────────────
    HubWebSocket.accepting = false;
    const managerA = new SyncManager();
    await managerA.init(makeConfig('device-a'));
    const clientA = managerA.getClient()!;

    const dropped: Error[] = [];
    clientA.onError = (err) => dropped.push(err);

    // One update per edit, fed to the client exactly as registerList() would.
    const updates: Uint8Array[] = [];
    const collect = (u: Uint8Array) => updates.push(u);
    docA.on('update', collect);
    for (let i = 0; i <= MAX_QUEUE_SIZE; i++) {
      docA.getMap('recon').set(`item-${String(i).padStart(4, '0')}`, i);
    }
    docA.off('update', collect);
    expect(updates).toHaveLength(MAX_QUEUE_SIZE + 1);

    for (const update of updates) clientA.sendUpdate(LIST_ID, update);

    // The queue is full, so the oldest entry — item-0000's update — is gone.
    expect(clientA.getPendingCount()).toBe(MAX_QUEUE_SIZE);
    expect(dropped.some((e) => /queue full/i.test(e.message))).toBe(true);

    // ─── Phase 2: the peer joins, then A reconnects and drains ─────────────
    // The WatermelonDB mock is one global store, so without this the "other
    // device" would restore device A's own persisted queue from disk. Let A's
    // fire-and-forget writes land first, then clear it.
    await settle();
    _resetDB();
    HubWebSocket.accepting = true;
    const clientB = new YjsWebSocketClient(makeConfig('device-b'));
    clientB.onRemoteUpdate = (_listId, update) => {
      Y.applyUpdate(docB, update);
    };
    clientB.onSyncRequest = (_listId, stateVector) => {
      clientB.sendUpdate(LIST_ID, Y.encodeStateAsUpdate(docB, stateVector));
    };
    await clientB.init();
    await settle();

    clientA.connect();
    await settle();
    await settle();

    // The 1000 surviving updates all reached the peer (merged into one frame
    // per list by the queue flush), and the peer can use none of them: Yjs
    // integrates updates causally, so every one of them sits in the pending
    // set waiting on the clock-0 update that was evicted. One dropped frame
    // does not cost one edit, it costs the whole list — and nothing in the
    // protocol ever asks for it again.
    const flushed = HubWebSocket.log.filter((m) => m.type === 'update' && m.deviceId === 'device-a');
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed.length).toBeLessThan(MAX_QUEUE_SIZE);
    expect(docB.getMap('recon').size).toBe(0);

    // ─── Phase 3: B asks what it missed ───────────────────────────────────
    clientB.sendStateVector(LIST_ID, Y.encodeStateVector(docB));
    await settle();
    await settle();

    // The delta A sends back carries the evicted update, which unblocks every
    // pending one behind it — the whole list arrives, not just the gap.
    expect(docB.getMap('recon').get('item-0000')).toBe(0);
    expect(docB.getMap('recon').size).toBe(MAX_QUEUE_SIZE + 1);

    // The relay must never see a plaintext state vector.
    const requests = HubWebSocket.log.filter((m) => m.type === 'sync_request');
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(typeof req.payload?.ciphertext).toBe('string');
      expect(req.payload.ciphertext.length).toBeGreaterThan(0);
      expect(typeof req.payload?.iv).toBe('string');
      expect(typeof req.payload?.tag).toBe('string');
      expect(req.stateVector).toBeUndefined();
    }

    // SyncManager reconciles on its own when the connection comes back —
    // device A announced its own state vector without being asked.
    expect(requests.some((m) => m.deviceId === 'device-a' && m.listId === LIST_ID)).toBe(true);

    clientB.disconnect();
    managerA.disconnect();
  }, 60_000);

  it('does not surface a sync error when the relay is too old to know sync_request', async () => {
    const errors: Error[] = [];
    const client = new YjsWebSocketClient(makeConfig('device-old-relay'));
    client.onError = (err) => errors.push(err);

    // The relay's `default:` branch answers unknown types with this exact shape.
    await (client as any).handleMessage({
      type: 'error',
      message: 'Unknown message type: sync_request',
    });
    expect(errors).toHaveLength(0);

    // Every other relay error still reaches the user.
    await (client as any).handleMessage({ type: 'error', message: 'Rate limit exceeded' });
    expect(errors.map((e) => e.message)).toEqual(['Rate limit exceeded']);

    // And we stop asking: one refusal disables reconciliation for the process
    // rather than producing one error frame per list per reconnect. Force the
    // client into the state where a send would otherwise go out.
    const framesOut: string[] = [];
    (client as any).ws = { readyState: HubWebSocket.OPEN, send: (d: string) => framesOut.push(d) };
    (client as any).state = 'connected';
    (client as any).ready = true;
    client.sendStateVector(LIST_ID, Y.encodeStateVector(new Y.Doc()));
    expect(framesOut).toHaveLength(0);

    // The same client still sends ordinary updates — only reconciliation stops.
    client.sendUpdate(LIST_ID, Y.encodeStateAsUpdate(new Y.Doc()));
    expect(framesOut.map((f) => JSON.parse(f).type)).toEqual(['update']);
  });
});
