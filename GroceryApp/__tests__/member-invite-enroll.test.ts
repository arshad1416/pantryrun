/**
 * Joined members must be able to invite, and a dead relay token must stop
 * the reconnect loop with a message the user can act on.
 *
 * 1. The relay only accepted invites signed by the family's founding device,
 *    because enrollment never told it the joiner's Ed25519 signing key. The
 *    client now sends that key with a proof of possession (the relay side is
 *    covered by relay-server/member-invites.test.js).
 * 2. "Relay token has expired" / "Invalid relay token" fell through to the
 *    auth timeout and the client reconnected with the same token forever.
 */

import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import sodium from 'libsodium-wrappers';
import { initCrypto } from '../src/crypto';
import { createFamilyInvite, enrollmentProofMessage } from '../src/identity/family';
import { enrollWithRelay } from '../src/identity/enroll';
import { YjsWebSocketClient, RELAY_AUTH_REJECTED_MESSAGE } from '../src/sync/y-websocket';

beforeAll(async () => {
  await initCrypto();
  await sodium.ready;
});

afterEach(() => {
  delete (globalThis as any).fetch;
  delete (globalThis as any).WebSocket;
});

describe('enrollment registers the joiner as an inviter', () => {
  it('sends this device\'s invite-signing key with a valid proof of possession', async () => {
    const founder = sodium.crypto_box_keypair();
    const joiner = sodium.crypto_box_keypair();
    const invite = await createFamilyInvite(founder);
    const deviceToken = sodium.to_base64(joiner.publicKey, sodium.base64_variants.ORIGINAL);

    let body: any = null;
    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ relayToken: 'tok', familyId: invite.familyId }) };
    });
    await enrollWithRelay('http://relay.test', deviceToken, JSON.stringify(invite), joiner);

    // The key the relay registers is the one the joiner's own invites carry.
    const joinersInvite = await createFamilyInvite(joiner, undefined, invite.familyId);
    expect(body.signingKey).toBe(joinersInvite.deviceId);
    const ok = sodium.crypto_sign_verify_detached(
      sodium.from_base64(body.signingProof, sodium.base64_variants.ORIGINAL),
      new TextEncoder().encode(enrollmentProofMessage(invite.familyId, invite.nonce!, deviceToken)),
      sodium.from_base64(body.signingKey, sodium.base64_variants.ORIGINAL),
    );
    expect(ok).toBe(true);
  });

  it('the join flow passes the device keypair', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/screens/PairingScreen.tsx'), 'utf-8');
    expect(src).toMatch(/enrollWithRelay\(httpBase, getDeviceId\(\), JSON\.stringify\(invite\), getDeviceKeypair\(\)\)/);
  });
});

describe('a rejected relay token', () => {
  class RejectingSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static created = 0;
    static closed = 0;
    readyState = RejectingSocket.OPEN;
    onopen: ((e: any) => void) | null = null;
    onclose: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    onmessage: ((e: any) => void) | null = null;
    constructor(_url: string) {
      RejectingSocket.created++;
      setTimeout(() => this.onopen?.({}), 0);
    }
    send(data: string): void {
      if (JSON.parse(data).type === 'auth') {
        // The relay replies with an error and leaves the socket open.
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'Relay token has expired. Re-enroll to continue.' }) }), 0);
      }
    }
    close(): void {
      RejectingSocket.closed++;
      this.readyState = RejectingSocket.CLOSED;
    }
  }

  it('stops reconnecting and reports that the device must be re-paired', async () => {
    (globalThis as any).WebSocket = RejectingSocket;
    const client = new YjsWebSocketClient({
      url: 'ws://relay.test', familyId: 'fam', deviceId: 'dev',
      encryptionKey: sodium.crypto_aead_xchacha20poly1305_ietf_keygen(), relayToken: 'expired',
      initialReconnectDelay: 5, maxReconnectDelay: 10,
    });
    const errors: string[] = [];
    const states: string[] = [];
    client.onError = (err) => errors.push(err.message);
    client.onStateChange = (state) => states.push(state);
    await client.init();
    await new Promise((r) => setTimeout(r, 100));

    expect(errors).toEqual([RELAY_AUTH_REJECTED_MESSAGE]);
    expect(client.getState()).toBe('error');
    expect(client.isAuthRejected()).toBe(true);
    expect(RejectingSocket.closed).toBe(1);
    // A later close or connect attempt does not start the loop again.
    client.connect();
    await new Promise((r) => setTimeout(r, 50));
    expect(RejectingSocket.created).toBe(1);
    await client.disconnect();
  });
});
