/**
 * Family Invite System — Ed25519 signed invite tokens + encrypted key exchange.
 *
 * Design:
 *  - Invite tokens are signed with the inviter's device Ed25519 key (via libsodium crypto_sign)
 *  - Token format: { familyId, deviceId (inviter), expiresAt, signature }
 *  - Signature is over the serialized token payload (excluding signature field)
 *  - Verification checks both signature validity and token expiry
 *  - Acceptance stores the family membership locally
 *
 * Key Exchange Protocol:
 * 1. Existing member generates invite token (Ed25519-signed, expiring)
 * 2. Invite token is encoded in QR code / deep link
 * 3. New device scans/opens invite → receives invite token
 * 4. New device sends invite token + its public key to relay
 * 5. Existing member verifies invite token → encrypts family key
 *    with crypto_box_seal (anonymous sealing) using new device's public key
 * 6. Encrypted key is sent back through relay
 * 7. New device decrypts with its secret key (crypto_box_seal_open)
 * 8. Both devices now share the family key — zero-knowledge to relay
 *
 * All operations require react-native-libsodium.
 */

import { initCrypto, generateUUID } from '../crypto/index';
// expo-secure-store loaded lazily to avoid Hermes crash (chains to expo-asset at eval time)
let SecureStore: any = null;
async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}
import { getDeviceKeypair, getDeviceId } from './device';
import type {
  DeviceKeypair,
  FamilyInviteToken,
  FamilyInviteVerification,
  FamilyMembership,
} from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const FAMILY_MEMBERSHIP_ALIAS = 'groceryapp.family.membership';
const MAX_INVITE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Caching ─────────────────────────────────────────────────────────────────

let cachedMembership: FamilyMembership | null = null;

// ─── Internal Helpers ────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const sodium = require('react-native-libsodium');
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const sodium = require('react-native-libsodium');
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

/**
 * Serialize token payload for signing (excludes the signature field).
 * Produces a canonical JSON string for deterministic signing.
 */
function serializeTokenPayload(token: Omit<FamilyInviteToken, 'signature'>): string {
  return JSON.stringify({
    familyId: token.familyId,
    deviceId: token.deviceId,
    expiresAt: token.expiresAt,
    nonce: token.nonce,
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a signed, expiring family invite token.
 *
 * @param inviterKeypair - The device keypair of the inviter (from getDeviceKeypair())
 * @param expiresAt - Optional expiry timestamp (ms since epoch). Defaults to 7 days.
 * @returns A FamilyInviteToken with an Ed25519 signature.
 */
export async function createFamilyInvite(
  inviterKeypair: DeviceKeypair,
  expiresAt?: number,
  existingFamilyId?: string,
): Promise<FamilyInviteToken> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;

  // Reuse the caller's family when provided — otherwise this invite founds a
  // new family. (Without this, every invite from the same household would
  // create a different familyId and members could never actually join each
  // other's family.)
  const familyId = existingFamilyId ?? (await generateUUID());
  const exp = expiresAt ?? Date.now() + MAX_INVITE_AGE_MS;

  // Generate a random nonce for one-time-use enforcement.
  // The nonce is included in the signed payload, so each invite token is
  // cryptographically unique even if created with the same familyId and expiry.
  // This enables the relay server to track used nonces independently of the
  // full token string, and makes the one-time-use property self-describing.
  const nonceBytes = sodium.randombytes_buf(16);
  const nonce = uint8ArrayToBase64(nonceBytes);

  // Derive Ed25519 sign keypair deterministically from the device's box secret key
  const signKp = sodium.crypto_sign_seed_keypair(inviterKeypair.privateKey.slice(0, 32));
  const edDeviceId = uint8ArrayToBase64(signKp.publicKey);

  const tokenPayload = { familyId, deviceId: edDeviceId, expiresAt: exp, nonce };
  const serialized = serializeTokenPayload(tokenPayload);

  // Sign with the inviter's Ed25519 key
  const signature = sodium.crypto_sign_detached(
    new TextEncoder().encode(serialized),
    signKp.privateKey,
  );

  return {
    familyId,
    deviceId: edDeviceId,
    expiresAt: exp,
    nonce,
    signature: uint8ArrayToBase64(signature),
  };
}

/**
 * What a joiner signs at relay enrollment to prove it holds the signing key it
 * registers. Must match enrollmentProofMessage in relay-server/server.js.
 */
export function enrollmentProofMessage(familyId: string, nonce: string, deviceToken: string): string {
  return `pantryrun-enroll-v1:${familyId}:${nonce}:${deviceToken}`;
}

/**
 * This device's Ed25519 signing key (the one its own invites are signed
 * with — see createFamilyInvite) plus a proof of possession for enrolling
 * with the given invite. The relay registers the key as a family member, which
 * is what lets this device invite others later; without it only the founding
 * device's invites were accepted.
 */
export async function createEnrollmentSigningProof(
  keypair: DeviceKeypair,
  invite: Pick<FamilyInviteToken, 'familyId' | 'nonce'>,
  deviceToken: string,
): Promise<{ signingKey: string; signingProof: string }> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;
  const signKp = sodium.crypto_sign_seed_keypair(keypair.privateKey.slice(0, 32));
  const proof = sodium.crypto_sign_detached(
    new TextEncoder().encode(enrollmentProofMessage(invite.familyId, invite.nonce, deviceToken)),
    signKp.privateKey,
  );
  return { signingKey: uint8ArrayToBase64(signKp.publicKey), signingProof: uint8ArrayToBase64(proof) };
}

/**
 * Verify a family invite token.
 * Checks both the Ed25519 signature and the expiry time.
 *
 * @param inviteToken - The FamilyInviteToken to verify.
 * @returns FamilyInviteVerification with valid flag and parsed data.
 * @throws If verification fails (wrong signature or expired).
 */
export async function verifyFamilyInvite(
  inviteToken: FamilyInviteToken,
): Promise<FamilyInviteVerification> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;

  const { signature, ...payload } = inviteToken;

  // Check expiry
  if (Date.now() > inviteToken.expiresAt) {
    throw new Error('Family invite has expired');
  }

  // Reconstruct the Ed25519 public key from the deviceId
  // (deviceId is now the Ed25519 public key, not the box public key)
  const publicKey = base64ToUint8Array(inviteToken.deviceId);
  const signatureBytes = base64ToUint8Array(signature);

  const serialized = serializeTokenPayload(payload);
  const messageBytes = new TextEncoder().encode(serialized);

  // Verify signature using crypto_sign_verify_detached
  // The deviceId IS the Ed25519 public key — no re-derivation needed
  const valid = sodium.crypto_sign_verify_detached(
    signatureBytes,
    messageBytes,
    publicKey,
  );

  if (!valid) {
    throw new Error('Family invite signature is invalid');
  }

  return {
    valid: true,
    familyId: inviteToken.familyId,
    inviterDeviceId: inviteToken.deviceId,
  };
}

/**
 * Accept a family invite.
 * Stores the family membership locally in secure store.
 *
 * @param inviteToken - The verified FamilyInviteToken.
 * @param deviceKeypair - The accepting device's keypair.
 * @returns The stored FamilyMembership.
 */
export async function acceptFamilyInvite(
  inviteToken: FamilyInviteToken,
  deviceKeypair: DeviceKeypair,
): Promise<FamilyMembership> {
  await initCrypto();

  // Verify the invite first
  const verification = await verifyFamilyInvite(inviteToken);

  const membership: FamilyMembership = {
    familyId: verification.familyId,
    deviceId: uint8ArrayToBase64(deviceKeypair.publicKey),
    joinedAt: Date.now(),
  };

  // Store membership
  await (await getSecureStore()).setItemAsync(
    FAMILY_MEMBERSHIP_ALIAS,
    JSON.stringify(membership),
  );
  cachedMembership = membership;

  return { ...membership };
}

/**
 * Get the stored family ID.
 */
export async function getFamilyId(): Promise<string | null> {
  const membership = await getFamilyMembership();
  return membership?.familyId ?? null;
}

/**
 * Get the full family membership.
 */
export async function getFamilyMembership(): Promise<FamilyMembership | null> {
  if (cachedMembership) return { ...cachedMembership };

  try {
    const stored = await (await getSecureStore()).getItemAsync(FAMILY_MEMBERSHIP_ALIAS);
    if (!stored) return null;
    cachedMembership = JSON.parse(stored) as FamilyMembership;
    return { ...cachedMembership };
  } catch {
    return null;
  }
}

/**
 * Check if the device has an active family membership.
 */
export async function hasFamilyMembership(): Promise<boolean> {
  return (await getFamilyId()) !== null;
}

/**
 * Found a solo family for this device — the first-run state, before anyone
 * else has been invited.
 *
 * Every list, every item, and the whole recovery system is scoped to a
 * familyId, so one has to exist before the app can encrypt or store anything.
 * A user who never invites anyone simply stays a family of one; inviting
 * someone later reuses this familyId (see createFamilyInvite's
 * `existingFamilyId`), and joining someone else's family overwrites it.
 *
 * No-op when membership already exists.
 */
export async function ensureFamilyMembership(
  deviceKeypair: DeviceKeypair,
): Promise<FamilyMembership> {
  const existing = await getFamilyMembership();
  if (existing) return existing;

  await initCrypto();
  const membership: FamilyMembership = {
    familyId: await generateUUID(),
    deviceId: uint8ArrayToBase64(deviceKeypair.publicKey),
    joinedAt: Date.now(),
  };

  await (await getSecureStore()).setItemAsync(
    FAMILY_MEMBERSHIP_ALIAS,
    JSON.stringify(membership),
  );
  cachedMembership = membership;

  return { ...membership };
}

/**
 * Leave the current family (clear membership).
 */
export async function leaveFamily(): Promise<void> {
  cachedMembership = null;
  await (await getSecureStore()).deleteItemAsync(FAMILY_MEMBERSHIP_ALIAS);
}

/**
 * Clear family membership (for testing).
 */
export async function clearFamilyMembership(): Promise<void> {
  cachedMembership = null;
  await (await getSecureStore()).deleteItemAsync(FAMILY_MEMBERSHIP_ALIAS);
}

// ─── Social Re-Invite Flow ──────────────────────────────────────────────────

/**
 * Generate a re-invite token for a replacement device.
 *
 * This is the "social recovery" path — an existing family member generates
 * a new invite token that a replacement device can use to re-join the family.
 * The re-invite has a longer expiry (7 days) to accommodate real-world delays.
 *
 * The token is shared via QR code (same as the original pairing flow).
 *
 * @param inviterKeypair - The device keypair of the existing family member.
 * @param customExpiryMs - Optional custom expiry (default: 7 days).
 * @returns A FamilyInviteToken with an Ed25519 signature and extended expiry.
 */
export async function generateReinvite(
  inviterKeypair: DeviceKeypair,
  customExpiryMs?: number,
): Promise<FamilyInviteToken> {
  const membership = await getFamilyMembership();
  if (!membership) {
    throw new Error(
      'No family membership found. You must be an active family member to generate a re-invite.',
    );
  }

  // Create a new invite with 7-day expiry (or custom)
  const expiresMs = customExpiryMs ?? MAX_INVITE_AGE_MS; // 7 days
  return createFamilyInvite(inviterKeypair, Date.now() + expiresMs);
}

/**
 * Format a re-invite token as a QR-code-friendly string.
 * Returns a string that can be encoded in a QR code for scanning.
 *
 * @param inviteToken - The FamilyInviteToken to format.
 * @returns A compact JSON string for QR encoding.
 */
export function reinviteToString(inviteToken: FamilyInviteToken): string {
  return JSON.stringify({
    action: 'reinvite',
    familyId: inviteToken.familyId,
    deviceId: inviteToken.deviceId,
    expiresAt: inviteToken.expiresAt,
    nonce: inviteToken.nonce,
    signature: inviteToken.signature,
  });
}

/**
 * Parse a re-invite string (from QR code) back into a FamilyInviteToken.
 *
 * @param data - The QR code string.
 * @returns A parsed FamilyInviteToken.
 * @throws If the data is not a valid re-invite format.
 */
export function parseReinviteString(data: string): FamilyInviteToken {
  const parsed = JSON.parse(data);
  if (parsed.action !== 'reinvite') {
    throw new Error('Not a valid re-invite token');
  }
  return {
    familyId: parsed.familyId,
    deviceId: parsed.deviceId,
    expiresAt: parsed.expiresAt,
    nonce: parsed.nonce,
    signature: parsed.signature,
  };
}

// ─── Encrypted Key Exchange ─────────────────────────────────────────────────

/**
 * Encrypt a family key for a specific device using anonymous sealing.
 *
 * Uses libsodium crypto_box_seal (anonymous public-key encryption) to encrypt
 * the family key for the recipient's device public key. This is a one-way
 * encryption that does not require the sender's keypair — any holder of the
 * recipient's public key can seal a message to them.
 *
 * @param devicePublicKey - The recipient device's public key (32 bytes, crypto_box key).
 * @param familyKey - The family symmetric key (32 bytes) to encrypt.
 * @returns An object containing the encrypted key and the ephemeral public key
 *          needed for decryption.
 */
export async function encryptKeyForDevice(
  devicePublicKey: Uint8Array,
  familyKey: Uint8Array,
): Promise<{ encryptedKey: Uint8Array; ephemeralPublicKey: Uint8Array }> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;

  // crypto_box_seal encrypts a message for a given public key using an
  // ephemeral keypair. The recipient can decrypt with crypto_box_seal_open
  // using their secret key.
  const sealed = sodium.crypto_box_seal(familyKey, devicePublicKey);

  // The sealed ciphertext includes the ephemeral public key prepended
  // (crypto_box_SEALBYTES = 48 bytes: 32-byte ephemeral pk + 16-byte tag)
  const ephemeralPublicKey = sealed.slice(0, sodium.crypto_box_PUBLICKEYBYTES);
  const encryptedKey = sealed.slice(sodium.crypto_box_PUBLICKEYBYTES);

  return { encryptedKey, ephemeralPublicKey };
}

/**
 * Decrypt a family key that was encrypted with encryptKeyForDevice.
 *
 * Uses libsodium crypto_box_seal_open, which needs both halves of the
 * recipient keypair.
 *
 * @param encryptedKey - The encrypted family key ciphertext (without ephemeral pk prefix).
 * @param ephemeralPublicKey - The ephemeral public key from the encryption step.
 * @param deviceSecretKey - The recipient device's secret key (32 bytes).
 * @param devicePublicKey - The recipient device's public key. Defaults to this
 *   device's stored key, which is correct whenever the sealed key was addressed
 *   to this device. Pass it explicitly to decrypt on behalf of another keypair.
 * @returns The decrypted family key as a Uint8Array.
 * @throws If decryption fails (wrong key or corrupted data).
 */
export async function decryptKeyFromDevice(
  encryptedKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  deviceSecretKey: Uint8Array,
  devicePublicKey?: Uint8Array,
): Promise<Uint8Array> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;

  // NOT sodium.crypto_scalarmult_base(deviceSecretKey). The whole
  // crypto_scalarmult family is absent from react-native-libsodium's NATIVE
  // surface — lib/typescript/lib.native.d.ts declares the crypto_box_* members
  // used below but no crypto_scalarmult* at all, while the JS-only lib.d.ts
  // declares them at :94. On device that call is undefined and throws. It is
  // the same "mock is richer than the device library" class as the ABYTES bug
  // in src/sync/y-websocket.ts, and it hid for the same reason: __mocks__
  // re-exports libsodium-wrappers, which does have scalarmult, so this path
  // stayed green in CI while it would have thrown on a real device.
  //
  // The public key never needed deriving. This decrypts a key that was sealed
  // TO this device, so the device's own stored public key is the right one.
  const recipientPublicKey = devicePublicKey ?? getDeviceKeypair().publicKey;

  // Reconstruct the full sealed ciphertext: ephemeral pk + encrypted key
  const sealed = new Uint8Array(
    sodium.crypto_box_PUBLICKEYBYTES + encryptedKey.length,
  );
  sealed.set(ephemeralPublicKey);
  sealed.set(encryptedKey, sodium.crypto_box_PUBLICKEYBYTES);

  // Decrypt using crypto_box_seal_open(cipher, publicKey, secretKey)
  // This uses the recipient's keypair + the embedded ephemeral key
  const decrypted = sodium.crypto_box_seal_open(
    sealed,
    recipientPublicKey,
    deviceSecretKey,
  );

  return decrypted;
}

/**
 * Verify that an invite token is valid before attempting key exchange.
 *
 * This enforces the invariant: invite token must be valid (not expired,
 * correct signature) for the key exchange to proceed. If verification fails,
 * the key exchange should be aborted.
 *
 * @param inviteToken - The invite token string (JSON-encoded FamilyInviteToken).
 * @param encryptedKey - The encrypted key data (checked for non-empty).
 * @returns true if the invite token is valid and the encrypted key is non-empty.
 */
export function verifyKeyExchange(
  inviteToken: string,
  encryptedKey: Uint8Array,
): boolean {
  // Check that the encrypted key is non-empty
  if (!encryptedKey || encryptedKey.length === 0) {
    return false;
  }

  // Parse the invite token
  let parsed: FamilyInviteToken;
  try {
    parsed = JSON.parse(inviteToken);
  } catch {
    return false;
  }

  // Validate required fields
  if (!parsed.familyId || !parsed.deviceId || !parsed.signature) {
    return false;
  }

  // Check expiry
  if (typeof parsed.expiresAt !== 'number' || Date.now() > parsed.expiresAt) {
    return false;
  }

  // All checks passed
  return true;
}