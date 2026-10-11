/**
 * Native-API fidelity: the XChaCha20-Poly1305 tag length constant (C5, L3).
 *
 * react-native-libsodium's *native* surface (lib.native.d.ts) declares
 * `crypto_aead_xchacha20poly1305_ietf_NPUBBYTES` but never declares
 * `crypto_aead_xchacha20poly1305_ietf_ABYTES`. The JS-only surface (lib.d.ts)
 * declares both, and the Jest mock delegates to libsodium-wrappers — which
 * also declares both. So the whole suite is more capable than the device, and
 * every `sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES` read that is fine
 * in CI is `undefined` on a real phone.
 *
 * `length - undefined` is NaN, `slice(0, NaN)` is empty and `slice(NaN)` is
 * the whole buffer, so an envelope built that way ships `ciphertext: ""` with
 * cipher||tag in `tag`. For the offline queue that is silent data loss:
 * base64 of a zero-length array is "", which is falsy, so
 * `offline-queue-store.loadQueueEntries` discards every persisted row on the
 * next launch — in the queue whose entire purpose is surviving an app kill.
 *
 * These tests run the real code paths against a sodium shim that reproduces
 * the device's missing constant. `src/crypto/index.ts` already hardcodes
 * `const ABYTES = 16` for exactly this reason; the sync and notification
 * paths must too.
 *
 * Run: npx jest __tests__/native-abytes-fidelity.test.ts
 */

import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import realSodium from 'libsodium-wrappers';

// ─── Device-fidelity sodium shim ─────────────────────────────────────────────
// Everything libsodium-wrappers offers, minus the one constant the native
// module never exposes. A Proxy (rather than a copy) keeps the shim live:
// libsodium-wrappers populates its exports during `ready`, and the app code
// requires the module lazily at an unpredictable point.
jest.mock('react-native-libsodium', () => {
  const real = require('libsodium-wrappers');
  return new Proxy(real, {
    get(target: any, prop: string | symbol) {
      if (prop === 'crypto_aead_xchacha20poly1305_ietf_ABYTES') return undefined;
      return target[prop];
    },
  });
});

// Notification path dependencies — none of them are exercised here, but they
// are imported at module scope by NotificationManager.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true });
jest.mock('expo-notifications', () => ({
  setNotificationChannelAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setBadgeCountAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}), { virtual: true });
jest.mock('../src/identity/device', () => ({ getDeviceId: () => 'device-sender' }));

const sentNotifications: any[] = [];
jest.mock('../src/sync/sync-manager', () => ({
  syncManager: {
    sendNotification: (listId: string, payload: any) => {
      sentNotifications.push({ listId, payload });
    },
  },
}));

import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { loadQueueEntries } from '../src/sync/offline-queue-store';
import { sendFamilyNotification } from '../src/notifications/NotificationManager';

const { _resetDB } = require('@nozbe/watermelondb') as any;

const ABYTES = 16; // XChaCha20-Poly1305 authentication tag length

// ─── WebSocket stub: never connects, so everything queues ───────────────────

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

let encryptionKey: Uint8Array;

beforeAll(async () => {
  await realSodium.ready;
  encryptionKey = realSodium.crypto_aead_xchacha20poly1305_ietf_keygen();
});

afterEach(() => {
  _resetDB();
  sentNotifications.length = 0;
  delete (globalThis as any).WebSocket;
});

function makeConfig() {
  return {
    url: 'ws://localhost:9999',
    familyId: 'fam-abytes',
    deviceId: 'device-abytes',
    encryptionKey,
    allowUnauthenticated: true,
  } as any;
}

/** Persistence is fire-and-forget; let the promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/** Wait for the queued write itself; a fixed delay flakes under parallel load. */
async function settleQueue(count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await loadQueueEntries()).length >= count) return;
    await settle();
  }
}

describe('C5 — a queued offline edit survives a restart on a device without ABYTES', () => {
  it('writes a non-empty ciphertext and a 16-byte tag to disk', async () => {
    (globalThis as any).WebSocket = NoopWebSocket;
    const client = new YjsWebSocketClient(makeConfig());
    await client.init();

    const plaintext = new TextEncoder().encode('milk-oats-and-a-long-enough-body');
    client.sendUpdate('list-c5', plaintext);
    await settleQueue(1);

    const persisted = await loadQueueEntries();
    expect(persisted).toHaveLength(1);

    const { ciphertext, tag } = persisted[0].payload;
    // The bug produces ciphertext === '' and tag === base64(cipher||tag).
    expect(ciphertext).not.toBe('');
    const rawCiphertext = realSodium.from_base64(ciphertext, realSodium.base64_variants.ORIGINAL);
    const rawTag = realSodium.from_base64(tag, realSodium.base64_variants.ORIGINAL);
    expect(rawCiphertext.length).toBe(plaintext.length);
    expect(rawTag.length).toBe(ABYTES);

    client.disconnect();
  });

  it('restores the persisted entry into a fresh client after an app kill', async () => {
    (globalThis as any).WebSocket = NoopWebSocket;
    const clientA = new YjsWebSocketClient(makeConfig());
    await clientA.init();
    clientA.sendUpdate('list-c5-kill', new TextEncoder().encode('survives-the-kill'));
    await settleQueue(1);
    clientA.disconnect(); // ~app kill: the in-memory queue dies with the instance

    // Fresh process, same key. This is the assertion the bug breaks: the row
    // is on disk but its ciphertext is '', so loadQueueEntries drops it and
    // the edit is gone from the family forever.
    const clientB = new YjsWebSocketClient(makeConfig());
    await clientB.init();
    expect(clientB.getPendingCount()).toBe(1);
    clientB.disconnect();
  });
});

describe('L3 — the notification envelope splits at the right offset', () => {
  it('encrypts with a non-empty ciphertext and a 16-byte tag that round-trips', async () => {
    await sendFamilyNotification(
      'item_added',
      'list-notify',
      'Weekly Shop',
      'item-1',
      'Oat Milk',
      'dairy',
      encryptionKey,
    );

    expect(sentNotifications).toHaveLength(1);
    const { ciphertext, iv, tag } = sentNotifications[0].payload;
    expect(ciphertext).not.toBe('');

    const rawCiphertext = realSodium.from_base64(ciphertext, realSodium.base64_variants.ORIGINAL);
    const rawTag = realSodium.from_base64(tag, realSodium.base64_variants.ORIGINAL);
    expect(rawCiphertext.length).toBeGreaterThan(0);
    expect(rawTag.length).toBe(ABYTES);

    // The pair is self-consistent, so a correctly-split envelope must still
    // decrypt when reassembled in the documented ciphertext||tag order.
    const cipherWithTag = new Uint8Array(rawCiphertext.length + rawTag.length);
    cipherWithTag.set(rawCiphertext);
    cipherWithTag.set(rawTag, rawCiphertext.length);
    const plaintext = realSodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      cipherWithTag,
      new TextEncoder().encode('list-notify'),
      realSodium.from_base64(iv, realSodium.base64_variants.ORIGINAL),
      encryptionKey,
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext)).itemName).toBe('Oat Milk');
  });
});
