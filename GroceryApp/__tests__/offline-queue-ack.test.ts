/**
 * Offline queue replay must not lose edits to the relay's rate limit.
 *
 * flushOfflineQueue used to send every queued update (up to 1000) as its own
 * frame in one burst and delete each from disk right after ws.send. The relay
 * allows 100 messages a minute per device, so everything past the 100th frame
 * was refused — and already gone from the only device that had it.
 *
 * Now the queue is merged into one frame per list, and an entry is deleted
 * only once the relay acks the frame (by msgId) that carried it.
 */

import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import * as Y from 'yjs';
import sodium from 'libsodium-wrappers';
import { initCrypto } from '../src/crypto';
import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { loadQueueEntries } from '../src/sync/offline-queue-store';

const { _resetDB } = require('@nozbe/watermelondb') as any;

/**
 * A relay with the real relay's update semantics: at most `budget` update
 * frames per window, each answered by an ack (or a rate-limit error) carrying
 * the frame's msgId. `acking = false` models a relay that never answers.
 */
class FakeRelaySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static accepting = false;
  static budget = 100;
  static acking = true;
  static stored: any[] = [];
  static frames: any[] = [];
  static sockets: FakeRelaySocket[] = [];
  readyState = FakeRelaySocket.CLOSED;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;

  constructor(_url: string) {
    if (!FakeRelaySocket.accepting) return;
    this.readyState = FakeRelaySocket.OPEN;
    FakeRelaySocket.sockets.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(data: string): void {
    const msg = JSON.parse(data);
    if (msg.type !== 'update') return;
    FakeRelaySocket.frames.push(msg);
    if (!FakeRelaySocket.acking) return;
    let reply: any;
    if (FakeRelaySocket.budget-- > 0) {
      FakeRelaySocket.stored.push(msg);
      reply = { type: 'ack', message: 'Update relayed', msgId: msg.msgId };
    } else {
      reply = { type: 'error', message: 'Rate limit exceeded (max 100 messages/min)', msgId: msg.msgId, retryAfterMs: 20 };
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
  }

  close(): void {
    this.readyState = FakeRelaySocket.CLOSED;
  }

  /** Server-side drop: the client sees a close. */
  drop(): void {
    this.readyState = FakeRelaySocket.CLOSED;
    this.onclose?.({});
  }
}

let encryptionKey: Uint8Array;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await initCrypto();
  await sodium.ready;
  encryptionKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
});

afterEach(() => {
  _resetDB();
  FakeRelaySocket.accepting = false;
  FakeRelaySocket.budget = 100;
  FakeRelaySocket.acking = true;
  FakeRelaySocket.stored = [];
  FakeRelaySocket.frames = [];
  FakeRelaySocket.sockets = [];
  delete (globalThis as any).WebSocket;
});

function makeClient() {
  return new YjsWebSocketClient({
    url: 'ws://relay.test',
    familyId: 'fam',
    deviceId: 'dev',
    encryptionKey,
    allowUnauthenticated: true,
    initialReconnectDelay: 10,
    maxReconnectDelay: 20,
  });
}

/** Queue `count` real Yjs edits for `listId` while offline. */
function queueEdits(client: YjsWebSocketClient, listId: string, count: number, doc = new Y.Doc()): Y.Doc {
  const collect = (u: Uint8Array) => client.sendUpdate(listId, u);
  doc.on('update', collect);
  for (let i = 0; i < count; i++) doc.getMap('items').set(`item-${i}`, i);
  doc.off('update', collect);
  return doc;
}

function decryptFrame(frame: any): Uint8Array {
  const nonce = sodium.from_base64(frame.payload.iv, sodium.base64_variants.ORIGINAL);
  const ct = sodium.from_base64(frame.payload.ciphertext, sodium.base64_variants.ORIGINAL);
  const tag = sodium.from_base64(frame.payload.tag, sodium.base64_variants.ORIGINAL);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct);
  joined.set(tag, ct.length);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, joined, frame.listId, nonce, encryptionKey);
}

describe('offline queue replay', () => {
  it('delivers 300 queued edits through a 100-frame relay budget, losing none', async () => {
    (globalThis as any).WebSocket = FakeRelaySocket;
    const client = makeClient();
    await client.init();
    queueEdits(client, 'list-a', 250);
    queueEdits(client, 'list-b', 50);
    expect(client.getPendingCount()).toBe(300);
    await settle();
    expect((await loadQueueEntries()).length).toBe(300);

    FakeRelaySocket.accepting = true;
    client.connect();
    await settle(100);

    // One merged frame per list, well inside the budget.
    expect(FakeRelaySocket.frames.length).toBe(2);
    const replicas = { 'list-a': new Y.Doc(), 'list-b': new Y.Doc() } as Record<string, Y.Doc>;
    for (const frame of FakeRelaySocket.stored) Y.applyUpdate(replicas[frame.listId], decryptFrame(frame));
    expect(replicas['list-a'].getMap('items').size).toBe(250);
    expect(replicas['list-b'].getMap('items').size).toBe(50);

    expect(client.getPendingCount()).toBe(0);
    expect((await loadQueueEntries()).length).toBe(0);
    await client.disconnect();
  });

  it('keeps queued edits on disk until the relay acks them, and resends after a drop', async () => {
    (globalThis as any).WebSocket = FakeRelaySocket;
    const client = makeClient();
    await client.init();
    queueEdits(client, 'list-a', 20);
    await settle();

    FakeRelaySocket.accepting = true;
    FakeRelaySocket.acking = false; // frames go out, nothing answers
    client.connect();
    await settle();
    expect(FakeRelaySocket.frames.length).toBe(1);
    expect(client.getPendingCount()).toBe(20);
    expect((await loadQueueEntries()).length).toBe(20);

    // The connection dies before any ack: the next connection resends.
    FakeRelaySocket.acking = true;
    FakeRelaySocket.sockets[0].drop();
    await settle(150);
    expect(FakeRelaySocket.stored.length).toBe(1);
    expect(client.getPendingCount()).toBe(0);
    expect((await loadQueueEntries()).length).toBe(0);
    await client.disconnect();
  });

  it('retries a flush the relay refused instead of forgetting it', async () => {
    (globalThis as any).WebSocket = FakeRelaySocket;
    const client = makeClient();
    const errors: Error[] = [];
    client.onError = (err) => errors.push(err);
    await client.init();
    queueEdits(client, 'list-a', 10);
    await settle();

    FakeRelaySocket.budget = 0; // first attempt is rate limited
    FakeRelaySocket.accepting = true;
    client.connect();
    await settle(10);
    expect((await loadQueueEntries()).length).toBe(10);
    FakeRelaySocket.budget = 100;
    await settle(100);

    expect(FakeRelaySocket.stored.length).toBe(1);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, decryptFrame(FakeRelaySocket.stored[0]));
    expect(replica.getMap('items').size).toBe(10);
    expect((await loadQueueEntries()).length).toBe(0);
    // A transient refusal is not a user-facing sync error.
    expect(errors).toEqual([]);
    await client.disconnect();
  });
});
