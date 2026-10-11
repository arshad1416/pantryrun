/**
 * A relay that never answers `auth` within 10s must not stop sync for good.
 * The timeout used to call disconnect(), which disposes the client, so every
 * later reconnect was a no-op until the app restarted.
 *
 * Run: npx jest __tests__/auth-timeout-reconnect.test.ts
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import sodium from 'libsodium-wrappers';
import { YjsWebSocketClient } from '../src/sync/y-websocket';

const sockets: SilentWebSocket[] = [];

/** Opens, accepts sends, and never replies — a stalled handshake. */
class SilentWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState: number = SilentWebSocket.CONNECTING;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  constructor(_url: string) {
    sockets.push(this);
  }
  open(): void {
    this.readyState = SilentWebSocket.OPEN;
    this.onopen?.({});
  }
  send(_data: string): void {}
  close(): void {
    this.readyState = SilentWebSocket.CLOSED;
  }
}

describe('auth_ack timeout', () => {
  let client: YjsWebSocketClient | null = null;

  afterEach(async () => {
    jest.useRealTimers();
    await client?.disconnect();
    client = null;
    sockets.length = 0;
  });

  it('retries the connection instead of disposing the client', async () => {
    await sodium.ready;
    (globalThis as any).WebSocket = SilentWebSocket;
    client = new YjsWebSocketClient({
      url: 'ws://localhost:9996',
      familyId: 'fam-timeout',
      deviceId: 'device-timeout',
      encryptionKey: sodium.crypto_aead_xchacha20poly1305_ietf_keygen(),
      relayToken: 'token',
      initialReconnectDelay: 100,
      maxReconnectDelay: 100,
    } as any);
    const errors: Error[] = [];
    client.onError = (err) => errors.push(err);
    await client.init();
    expect(sockets).toHaveLength(1);

    jest.useFakeTimers();
    sockets[0].open();
    jest.advanceTimersByTime(10_000);
    expect(errors.some((e) => /Authentication timeout/.test(e.message))).toBe(true);

    jest.advanceTimersByTime(1_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });
});
