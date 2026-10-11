/**
 * Offline queue persistence — verifies that Yjs updates queued while the
 * relay is unreachable survive an app kill.
 *
 * Simulation:
 *  1. Client A (never connects) queues updates → entries persisted to
 *     WatermelonDB (mocked) as encrypted envelopes.
 *  2. "App kill": client A is discarded.
 *  3. Client B (same encryption key, fresh instance) inits → restores the
 *     persisted queue into memory.
 *  4. On (fake) connect, the restored updates are sent and removed from disk.
 */

import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import sodium from 'libsodium-wrappers';
import { initCrypto } from '../src/crypto';
import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { loadQueueEntries } from '../src/sync/offline-queue-store';
// The watermelondb mock (jest moduleNameMapper) exposes _resetDB; the real
// package types don't, hence the require + any.
const { _resetDB } = require('@nozbe/watermelondb') as any;

// ─── WebSocket stubs ─────────────────────────────────────────────────────────

class NoopWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState: number = NoopWebSocket.CLOSED;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  constructor(_url: string) {}
  send(_data: string): void {}
  close(): void {
    this.readyState = NoopWebSocket.CLOSED;
  }
}

/** WebSocket that "connects" immediately and records sent messages. */
class RecordingWebSocket extends NoopWebSocket {
  static sent: any[] = [];
  constructor(url: string) {
    super(url);
    this.readyState = NoopWebSocket.OPEN;
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data);
    RecordingWebSocket.sent.push(msg);
    // The relay acks a stored update, echoing its msgId; only then may the
    // client delete its queued copy.
    if (msg.type === 'update' && msg.msgId) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ack', message: 'Update relayed', msgId: msg.msgId }) }), 0);
    }
  }
}

let encryptionKey: Uint8Array;

beforeAll(async () => {
  await initCrypto();
  await sodium.ready;
  encryptionKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
});

afterEach(() => {
  _resetDB();
  RecordingWebSocket.sent = [];
  delete (globalThis as any).WebSocket;
});

function makeConfig() {
  return {
    url: 'ws://localhost:9999',
    familyId: 'fam-1',
    deviceId: 'device-1',
    encryptionKey,
    allowUnauthenticated: true,
  } as any;
}

describe('Offline queue persistence across app kill', () => {
  it('persists queued updates to disk as encrypted envelopes', async () => {
    (globalThis as any).WebSocket = NoopWebSocket;
    const clientA = new YjsWebSocketClient(makeConfig());
    await clientA.init();

    const update = new TextEncoder().encode('fake-yjs-update-bytes');
    clientA.sendUpdate('list-1', update);
    expect(clientA.getPendingCount()).toBe(1);

    // persistence is async fire-and-forget — let it settle
    await new Promise((r) => setTimeout(r, 50));

    const persisted = await loadQueueEntries();
    expect(persisted.length).toBe(1);
    expect(persisted[0].listId).toBe('list-1');
    // Stored payload must be the encrypted envelope, not plaintext
    expect(persisted[0].payload.ciphertext).toBeDefined();
    const raw = JSON.stringify(persisted[0].payload);
    expect(raw).not.toContain('fake-yjs-update-bytes');
    clientA.disconnect();
  });

  it('restores the queue after an app kill and delivers on reconnect', async () => {
    // Phase 1: offline client queues an update, then the app dies
    (globalThis as any).WebSocket = NoopWebSocket;
    const clientA = new YjsWebSocketClient(makeConfig());
    await clientA.init();
    const update = new TextEncoder().encode('survives-app-kill');
    clientA.sendUpdate('list-42', update);
    await new Promise((r) => setTimeout(r, 50));
    clientA.disconnect(); // ~app kill (in-memory queue discarded with instance)

    expect((await loadQueueEntries()).length).toBe(1);

    // Phase 2: fresh process, same key — client restores and connects
    (globalThis as any).WebSocket = RecordingWebSocket;
    const clientB = new YjsWebSocketClient(makeConfig());
    await clientB.init();
    expect(clientB.getPendingCount()).toBe(1);

    // Let the fake socket "open" and the queue flush
    await new Promise((r) => setTimeout(r, 50));

    const updateMsgs = RecordingWebSocket.sent.filter((m) => m.type === 'update');
    expect(updateMsgs.length).toBe(1);
    expect(updateMsgs[0].listId).toBe('list-42');
    expect(updateMsgs[0].payload.ciphertext).toBeDefined();

    // Delivered entries are removed from disk
    await new Promise((r) => setTimeout(r, 50));
    expect((await loadQueueEntries()).length).toBe(0);
    expect(clientB.getPendingCount()).toBe(0);
    clientB.disconnect();
  });

  it('drops persisted entries that no longer decrypt (key changed)', async () => {
    (globalThis as any).WebSocket = NoopWebSocket;
    const clientA = new YjsWebSocketClient(makeConfig());
    await clientA.init();
    clientA.sendUpdate('list-x', new TextEncoder().encode('old-key-data'));
    await new Promise((r) => setTimeout(r, 50));
    clientA.disconnect();

    // New client with a DIFFERENT key cannot decrypt the persisted entry
    const otherKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const clientB = new YjsWebSocketClient({ ...makeConfig(), encryptionKey: otherKey });
    await clientB.init();
    expect(clientB.getPendingCount()).toBe(0);

    await new Promise((r) => setTimeout(r, 50));
    expect((await loadQueueEntries()).length).toBe(0);
    clientB.disconnect();
  });
});
