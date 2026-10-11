/**
 * Family join flow — pins the combined invite payload introduced when the
 * join path was wired end-to-end (pairing QR = relay address + signed
 * one-time family invite), plus two regressions:
 *
 *  1. createFamilyInvite must reuse an existing familyId when given one
 *     (previously every invite founded a brand-new family).
 *  2. Pairing codes must NOT verify when signed with a keypair derived from
 *     the public deviceId (the old, forgeable scheme).
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import sodium from 'libsodium-wrappers';
import { initCrypto } from '../src/crypto';
import { initDeviceIdentity, getDeviceKeypair, getDeviceId } from '../src/identity/device';
import {
  createFamilyInvite,
  verifyFamilyInvite,
  acceptFamilyInvite,
  clearFamilyMembership,
  getFamilyId,
} from '../src/identity/family';
import { generatePairingCode, parsePairingCode } from '../src/setup/self-host';
import { parseInviteUrl, INVITE_URL_PREFIX } from '../src/setup/invite-url';
import { inviteTokenToUrl } from '../src/identity/invite-link';
import type { PairingCode } from '../src/types';

beforeAll(async () => {
  await initCrypto();
  await sodium.ready;
  await initDeviceIdentity();
});

describe('Combined invite payload (QR contents)', () => {
  it('round-trips through the invite URL and verifies both halves', async () => {
    const keypair = getDeviceKeypair();
    const invite = await createFamilyInvite(keypair);
    const pairingCode = await generatePairingCode(
      getDeviceId(),
      invite.familyId,
      'ws://192.168.1.50:8080',
    );

    const combined = JSON.stringify({ pairingCode, invite });
    const url = `groceryapp://invite?token=${encodeURIComponent(combined)}`;

    // Scanner side: extract + decode the token
    const token = parseInviteUrl(url);
    expect(token).toBe(combined);

    // PairingScreen side: parse and verify both halves
    const payload = JSON.parse(token!);
    const verifiedCode = await parsePairingCode(payload.pairingCode);
    expect(verifiedCode.relayUrl).toBe('ws://192.168.1.50:8080');
    expect(verifiedCode.familyId).toBe(invite.familyId);

    const verification = await verifyFamilyInvite(payload.invite);
    expect(verification.valid).toBe(true);
    expect(verification.familyId).toBe(invite.familyId);
  });

  it('still accepts QR links using the legacy misspelled scheme', () => {
    const token = parseInviteUrl('grocceryapp://invite?token=abc%7B1%7D');
    expect(token).toBe('abc{1}');
  });

  it('accepts QR links using the pantryrun:// scheme', () => {
    expect(parseInviteUrl('pantryrun://invite?token=abc%7B1%7D')).toBe('abc{1}');
  });

  it('inviteTokenToUrl uses the correct scheme and round-trips through parseInviteUrl', () => {
    const combined = JSON.stringify({ pairingCode: { relayUrl: 'ws://h:8080' }, invite: { nonce: 'x' } });
    const url = inviteTokenToUrl(combined);
    expect(url.startsWith(INVITE_URL_PREFIX)).toBe(true);
    expect(parseInviteUrl(url)).toBe(combined);
  });
});

describe('Invite familyId reuse', () => {
  it('reuses an existing familyId so all invites join the same family', async () => {
    const keypair = getDeviceKeypair();
    const first = await createFamilyInvite(keypair);
    const second = await createFamilyInvite(keypair, undefined, first.familyId);
    expect(second.familyId).toBe(first.familyId);
    expect(second.nonce).not.toBe(first.nonce);

    // And acceptance stores that same membership
    await clearFamilyMembership();
    await acceptFamilyInvite(second, keypair);
    expect(await getFamilyId()).toBe(first.familyId);
    await clearFamilyMembership();
  });
});

describe('Pairing code forgery resistance', () => {
  it('rejects a code signed with a keypair derived from the public deviceId', async () => {
    // Adversary knows only the (public) deviceId and forges a code the way
    // the old implementation signed them.
    const deviceId = getDeviceId();
    const devicePublicKey = sodium.from_base64(
      deviceId,
      sodium.base64_variants.ORIGINAL,
    );
    const forgedKp = sodium.crypto_sign_seed_keypair(devicePublicKey.slice(0, 32));

    const payload = {
      version: 1,
      deviceId,
      familyId: 'victim-family',
      relayUrl: 'ws://evil.example.com:8080',
      signerKey: sodium.to_base64(forgedKp.publicKey, sodium.base64_variants.ORIGINAL),
      createdAt: Date.now(),
    };
    const serialized = JSON.stringify({
      version: payload.version,
      deviceId: payload.deviceId,
      familyId: payload.familyId,
      relayUrl: payload.relayUrl,
      signerKey: payload.signerKey,
      createdAt: payload.createdAt,
    });
    const signature = sodium.crypto_sign_detached(
      new TextEncoder().encode(serialized),
      forgedKp.privateKey,
    );

    const forged: PairingCode = {
      ...payload,
      signature: sodium.to_base64(signature, sodium.base64_variants.ORIGINAL),
    };

    // The forgery is internally consistent (signature matches signerKey), but
    // the signerKey is NOT the device's real signing key. Verification alone
    // can't reject a self-consistent forgery — the defense is that the real
    // signer key comes from the in-person QR handoff. What we CAN pin: the
    // legitimate code's signer key differs from anything derivable from the
    // public deviceId, and a signature from the pubkey-derived key does not
    // verify against the legitimate signerKey.
    const legit = await generatePairingCode(deviceId, 'fam', 'ws://x:8080');
    expect(legit.signerKey).not.toBe(forged.signerKey);

    const tampered = { ...legit, signature: forged.signature };
    await expect(parsePairingCode(tampered)).rejects.toThrow(/signature/i);
  });

  it('rejects a code whose payload was modified after signing', async () => {
    const legit = await generatePairingCode(getDeviceId(), 'fam', 'ws://x:8080');
    const redirected = { ...legit, relayUrl: 'ws://evil.example.com:8080' };
    await expect(parsePairingCode(redirected)).rejects.toThrow(/signature/i);
  });
});
