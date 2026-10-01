/**
 * Encryption layer using react-native-libsodium (XChaCha20-Poly1305 AEAD + Argon2id KDF).
 *
 * Design:
 *  - Master key derived from family passphrase via libsodium crypto_pwhash (Argon2id,
 *    OPSLIMIT_MODERATE / MEMLIMIT_MODERATE), replacing the previous PBKDF2-HMAC-SHA256.
 *  - Master key stored in expo-secure-store (passphrase NEVER stored)
 *  - Each encryption uses XChaCha20-Poly1305 with a fresh random nonce
 *  - Ciphertext, nonce, and auth tag stored together via EncryptedData envelope
 *  - AAD (Additional Authenticated Data) binds each ciphertext to its field context,
 *    supported natively by libsodium's AEAD interface
 *  - UUID v4 generated via libsodium's randombytes_buf for crypto-safe randomness
 *  - Constant-time passphrase verification via a hand-rolled length-guarded XOR
 *    compare (`constantTimeEqual`), NOT sodium_memcmp — react-native-libsodium's
 *    native surface does not export memcmp
 */

import type { EncryptedData } from '../types';

// ─── Lazy SecureStore import ─────────────────────────────────────────────────
// IMPORTANT: must NOT be imported at the top level - Expo modules chain to
// expo-asset which triggers Hermes 0.85.3 crash during module evaluation.
let SecureStore: any = null;

async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}

// Helper to wrap SecureStore in a proxy that lazily initializes
const secureStoreProxy = new Proxy({}, {
  get(_target, prop: string) {
    return async (...args: any[]) => {
      const store = await getSecureStore();
      return (store as any)[prop](...args);
    };
  },
}) as any;

// ─── Lazy sodium import ──────────────────────────────────────────────────────
// IMPORTANT: react-native-libsodium MUST NOT be imported at the top level.
// Its native JSI install (Libsodium.install()) runs synchronously during
// module evaluation and can SIGSEGV if the Hermes JSI runtime is not fully
// ready. Deferring the import to first use (inside async initCrypto()) ensures
// React has loaded and the error handler is in place.
let sodium: any = null;

async function getSodium(): Promise<any> {
  if (!sodium) {
    const mod = await import('react-native-libsodium');
    sodium = mod.default;
  }
  return sodium;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const KEY_LENGTH_BYTES = 32; // sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
const NONCE_LENGTH_BYTES = 24; // sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const ABYTES = 16; // sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
const SALT_LENGTH_BYTES = 16; // Argon2id salt

const SECURE_STORE_KEY_ALIAS = 'groceryapp.master_key';

// Argon2id parameters (moderate — ~1s on mobile)
const OPSLIMIT = 3; // sodium.crypto_pwhash_OPSLIMIT_MODERATE
const MEMLIMIT = 268435456; // sodium.crypto_pwhash_MEMLIMIT_MODERATE

// ─── Ready / Init ─────────────────────────────────────────────────────────────

let ready = false;

/**
 * Ensure libsodium is initialised before any operation.
 * Must be called once at app startup.
 */
export async function initCrypto(): Promise<void> {
  if (!ready) {
    console.log('[crypto] Importing react-native-libsodium…');
    const s = await getSodium();
    console.log('[crypto] Module loaded, waiting for ready…');
    await s.ready;
    // Verify JSI functions are actually installed
    if (typeof (globalThis as any).jsi_randombytes_buf !== 'function') {
      console.warn('[crypto] WARNING: jsi_randombytes_buf not installed — Libsodium.install() may have failed');
    } else {
      console.log('[crypto] JSI functions verified (jsi_randombytes_buf present)');
    }
    ready = true;
    console.log('[crypto] initCrypto complete');
  }
}

async function ensureReady(): Promise<void> {
  if (!ready) {
    const s = await getSodium();
    await s.ready;
    ready = true;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function base64ToUint8Array(b64: string): Uint8Array {
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

/** Constant-time comparison. Replaces sodium.memcmp which react-native-libsodium doesn't export. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ─── Key Derivation (Argon2id via libsodium crypto_pwhash) ────────────────────

/**
 * Derive a 256-bit encryption key from a passphrase + salt using Argon2id.
 *
 * Uses libsodium's recommended memory-hard KDF:
 *   crypto_pwhash(keyLen, passwd, salt, opsLimit, memLimit, algo)
 *
 * Argon2id resists both side-channel and GPU/ASIC parallel attacks.
 * OPSLIMIT_MODERATE / MEMLIMIT_MODERATE target ~1 second on mobile devices.
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  const normalized = passphrase.normalize('NFKC');
  const key = sodium.crypto_pwhash(
    KEY_LENGTH_BYTES,
    normalized,
    salt,
    OPSLIMIT,
    MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return key;
}

/**
 * Generate a cryptographically random salt (16 bytes).
 */
export async function generateSalt(): Promise<Uint8Array> {
  await ensureReady();
  return sodium.randombytes_buf(SALT_LENGTH_BYTES);
}

/**
 * Generate a cryptographically random nonce (24 bytes for XChaCha20-Poly1305).
 */
export async function generateNonce(): Promise<Uint8Array> {
  await ensureReady();
  return sodium.randombytes_buf(NONCE_LENGTH_BYTES);
}

/**
 * Generate a cryptographically random UUID v4 string using libsodium.
 */
export async function generateUUID(): Promise<string> {
  await ensureReady();
  // 16 random bytes → format as UUID v4
  const bytes = sodium.randombytes_buf(16) as Uint8Array;
  // Set version (4) and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Encryption / Decryption (XChaCha20-Poly1305) ────────────────────────────

/**
 * Encrypt plaintext using XChaCha20-Poly1305 with AAD.
 *
 * AAD binds the ciphertext to a specific field context (e.g., 'grocery_item.name'),
 * preventing an attacker from moving ciphertext between fields.
 *
 * @param plaintext  - The text to encrypt (UTF-8).
 * @param key        - 256-bit encryption key as Uint8Array.
 * @param context    - AAD context string identifying the field being encrypted.
 * @returns EncryptedData containing ciphertext, nonce, and auth tag (all base64).
 */
export async function encrypt(
  plaintext: string,
  key: Uint8Array,
  context?: string,
): Promise<EncryptedData> {
  await ensureReady();
  const nonce = await generateNonce();
  const additionalData = context || null;

  // libsodium: crypto_aead_xchacha20poly1305_ietf_encrypt (react-native-libsodium takes string AAD)
  // Returns ciphertext + tag concatenated
  const cipherWithTag = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    additionalData,
    null, // no secret nonce
    nonce,
    key,
  );

  // Split ciphertext and auth tag
  const ciphertext = cipherWithTag.slice(0, cipherWithTag.length - ABYTES);
  const tag = cipherWithTag.slice(cipherWithTag.length - ABYTES);

  return {
    ciphertext: uint8ArrayToBase64(ciphertext),
    iv: uint8ArrayToBase64(nonce),
    tag: uint8ArrayToBase64(tag),
  };
}

/**
 * Decrypt ciphertext previously encrypted with `encrypt`.
 *
 * Uses the same context string as AAD to verify ciphertext integrity.
 *
 * @param data    - EncryptedData envelope.
 * @param key     - 256-bit encryption key as Uint8Array.
 * @param context - AAD context string (must match what was used during encryption).
 * @returns The original plaintext string.
 */
/**
 * A ciphertext failed its authentication tag.
 *
 * This is NEVER a transient error and reconnecting never fixes it. Poly1305
 * rejects with probability ~1-2^-128 unless the key is genuinely wrong, so in
 * practice it means exactly one thing: the key this device holds is not the
 * key the data was written under. Corruption and tampering land here too, but
 * they are far rarer than a key mismatch.
 *
 * It exists as a distinct type because the UI has to tell it apart from a
 * dropped socket. "Offline" resolves itself; this does not, and telling a user
 * their lists are "Syncing…" while every message fails to decrypt is the
 * failure mode this type is here to prevent.
 */
export class DecryptFailureError extends Error {
  constructor(
    /** Where it happened — a listId, or a field context like 'item.name'. */
    readonly context: string,
    override readonly cause?: unknown,
  ) {
    super(`Decryption failed for "${context}" — this device's key does not match the data.`);
    this.name = 'DecryptFailureError';
  }
}

export async function decrypt(
  data: EncryptedData,
  key: Uint8Array,
  context?: string,
): Promise<string> {
  await ensureReady();
  const nonce = base64ToUint8Array(data.iv);
  const tag = base64ToUint8Array(data.tag);
  const ciphertext = base64ToUint8Array(data.ciphertext);
  const additionalData = context || null;

  // Recombine ciphertext + tag for libsodium
  const cipherWithTag = new Uint8Array(ciphertext.length + tag.length);
  cipherWithTag.set(ciphertext);
  cipherWithTag.set(tag, ciphertext.length);

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, // no secret nonce
    cipherWithTag,
    additionalData,
    nonce,
    key,
  );

  return new TextDecoder().decode(plaintext);
}

// ─── Master Key Management ───────────────────────────────────────────────────

/**
 * Derive and persist the master key from a family passphrase.
 * The passphrase is NEVER stored on device — only the derived key.
 */
export async function setupMasterKey(passphrase: string): Promise<void> {
  await ensureReady();
  const salt = await generateSalt();
  const derivedKey = await deriveKeyFromPassphrase(passphrase, salt);
  const keyBase64 = uint8ArrayToBase64(derivedKey);
  const saltBase64 = uint8ArrayToBase64(salt);
  await secureStoreProxy.setItemAsync(
    SECURE_STORE_KEY_ALIAS,
    JSON.stringify({ key: keyBase64, salt: saltBase64, type: 'passphrase' }),
  );
}

/**
 * Retrieve the stored master key. Returns null if not yet set up.
 */
export async function getMasterKey(): Promise<Uint8Array | null> {
  await ensureReady();
  try {
    const stored = await secureStoreProxy.getItemAsync(SECURE_STORE_KEY_ALIAS);
    if (!stored) return null;
    const { key: keyBase64 } = JSON.parse(stored);
    return base64ToUint8Array(keyBase64);
  } catch {
    return null;
  }
}

/**
 * Derive a master key from a passphrase and return it ONLY if the passphrase
 * verifies against the stored key. Comparison is constant-time.
 *
 * Fail-closed by construction: every path that cannot complete the comparison
 * returns null. It must never return key material it has not verified, because
 * the name makes it the obvious thing to reach for when gating access — see the
 * fail-open this replaced (audit L5).
 *
 * That fail-open returned the stored key outright whenever the envelope was
 * tagged `type: 'recovery'`, on the reasoning that a recovery-minted key has no
 * passphrase to check. The reasoning was right and the conclusion was backwards:
 * with no passphrase to check, a passphrase check cannot succeed.
 *
 * Which devices actually rested in that state, precisely: `setMasterKey` writes
 * `'recovery'` on every key it stores, but first-run provisioning immediately
 * re-tags to `'device'` (`sync/bootstrap.ts:43`), so a fresh install never sat
 * on the vulnerable branch. The exposed population was devices restored from a
 * family recovery phrase (`identity/recovery.ts`), which are never re-tagged.
 *
 * A key with no salt is not a wrong passphrase, it is a device that has no
 * passphrase at all. Callers that need to tell those apart — to offer recovery
 * instead of re-prompting — ask `getMasterKeyType()`; distinguishing them here
 * would mean handing back a key on a path that verified nothing.
 *
 * @returns The verified key, or null if the passphrase is wrong, no key is
 *          stored, or the stored key is not passphrase-derived.
 */
export async function verifyAndGetMasterKey(
  passphrase: string,
): Promise<Uint8Array | null> {
  await ensureReady();
  const stored = await secureStoreProxy.getItemAsync(SECURE_STORE_KEY_ALIAS);
  if (!stored) return null;
  const parsed = JSON.parse(stored);

  // No salt ⇒ not passphrase-derived (recovery-minted, device-provisioned, or
  // the legacy untagged format) ⇒ nothing to verify against ⇒ refuse.
  const saltBase64 = parsed.salt;
  if (!saltBase64) return null;

  const salt = base64ToUint8Array(saltBase64);
  const derivedKey = await deriveKeyFromPassphrase(passphrase, salt);
  const storedKey = base64ToUint8Array(parsed.key);

  // Constant-time comparison
  const match = constantTimeEqual(derivedKey, storedKey);
  if (!match) {
    return null; // Wrong passphrase
  }
  return derivedKey;
}

/**
 * Check if a master key has been set up.
 */
export async function hasMasterKey(): Promise<boolean> {
  return (await getMasterKey()) !== null;
}

/**
 * Derive a sub-key for Yjs sync updates from the master key using libsodium's KDF.
 *
 * ⚠️ NOT WIRED UP. Read this before believing the app has key separation
 * (audit L4). This function is correct and tested, and **nothing calls it**:
 * `src/sync/bootstrap.ts` passes the master key itself as `encryptionKey`, so
 * the wire is encrypted under the root key. The previous version of this
 * comment asserted separation in the present tense, which made a security
 * property look shipped when only its helper was.
 *
 * What that costs today: the Yjs wire and locally stored data share one key,
 * so there is no compartment boundary between them. In the current design
 * nothing meaningfully leaks from it — the sub-key would be derived on-device
 * from a master key held in the same process — so it is defence in depth
 * rather than a live hole.
 *
 * Where it does matter, and why it is still deferred: voice-assistant linking
 * (`encryptMasterKeyWithAssistantPublicKey`) uploads the *root* master key to
 * the webhook, where a sync sub-key would be the least-privilege thing to send.
 * That path is default-off and its webhook is undeployed;
 * `docs/MONETIZATION.md` §2 and `docs/ARCHITECTURE-VOICE-ASSISTANTS.md` both
 * record this as required work before the feature can ship.
 *
 * Wiring it is a re-key, not a config change, and doing it naively loses user
 * data. `EncryptedData` ({ciphertext, iv, tag}) carries no version field, and
 * v1.31 is live in closed testing.
 *
 * The blast radius is wider than the wire, which is the part that makes the
 * one-line version of this change dangerous. `SyncManager` holds a SINGLE
 * `encryptionKey` field (`sync/sync-manager.ts:46`), set from this value at
 * `:57`, and it serves three corpora: the Yjs wire, local WatermelonDB field
 * ciphertext (`:295-299` → `storage/hydrate.ts`), and notification payloads
 * (`:220`). So changing what `bootstrap.ts` passes re-keys the local database
 * too, not just relay-held updates and the `offline_queue` rows. Every one of
 * those becomes undecryptable, and any family member on an older build
 * silently stops syncing.
 *
 * Doing it safely means: split that one field into wire-key and at-rest-key,
 * version the envelope, decrypt with a master-key fallback for a deprecation
 * window, then drop the fallback. `__tests__/key-separation.test.ts` is a
 * source-text heuristic over this comment and `bootstrap.ts` — it catches the
 * obvious drift in both directions, not every possible refactor.
 *
 * Uses crypto_kdf_derive_from_key with the 8-byte context string 'yjs-sync'.
 *
 * @param masterKey - The 256-bit master encryption key.
 * @param subKeyIndex - Optional sub-key index (default: 0). Use different indices
 *                      for different sub-keys if needed.
 * @returns A 256-bit derived sub-key.
 */
export async function deriveSyncKey(
  masterKey: Uint8Array,
  subKeyIndex: number = 0,
): Promise<Uint8Array> {
  await ensureReady();
  // crypto_kdf_derive_from_key(subKeyLen, subKeyId, ctx, masterKey)
  // ctx must be exactly 8 bytes
  return sodium.crypto_kdf_derive_from_key(
    KEY_LENGTH_BYTES,
    subKeyIndex,
    'yjs-sync',
    masterKey,
  );
}

/** A nonsecret stable namespace for local ciphertext owned by this key. */
export async function encryptionKeyFingerprint(key: Uint8Array): Promise<string> {
  await ensureReady();
  return sodium.to_hex(sodium.crypto_generichash(16, key));
}

/**
 * Derive a sub-key for local database encryption from the master key.
 *
 * Uses a distinct context string ('db-encr') to ensure domain separation:
 * the DB encryption key is cryptographically independent from the sync key
 * and the master key. Compromise of one key does not compromise the others.
 *
 * This key is intended for use with SQLCipher / encrypted SQLite adapters.
 * Currently, WatermelonDB's community SQLiteAdapter does not support
 * native encryption. Sensitive fields are encrypted at the application layer
 * (see src/storage/hydrate.ts). This function is provided so that when a
 * SQLCipher-capable native adapter is integrated, the key derivation is
 * already in place and tested.
 *
 * @param masterKey - The 256-bit master encryption key.
 * @returns A 256-bit derived sub-key for database encryption.
 */
export async function deriveDBKey(
  masterKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  return sodium.crypto_kdf_derive_from_key(
    KEY_LENGTH_BYTES,
    2, // distinct subkey ID from sync key (0) and future keys
    // Exactly crypto_kdf_CONTEXTBYTES (8), padded. This read 'db-encr' — seven
    // bytes — so every call threw `invalid ctx length`. Nothing called it, so
    // nothing broke, but the docstring below claimed the derivation was already
    // in place and tested when it could not run at all. Changing the context
    // changes the derived key; that is safe only because no data has ever been
    // encrypted under it. It will not be safe once SQLCipher ships.
    'db-encr ',
    masterKey,
  );
}

/**
 * Store a new master key directly (e.g. from recovery phrase).
 * Overwrites any existing master key.
 */
export async function setMasterKey(key: Uint8Array): Promise<void> {
  await ensureReady();
  const keyBase64 = uint8ArrayToBase64(key);
  await secureStoreProxy.setItemAsync(
    SECURE_STORE_KEY_ALIAS,
    JSON.stringify({ key: keyBase64, type: 'recovery' }),
  );
}

/**
 * How the stored master key came to exist.
 *
 *   'passphrase' — derived from a family passphrase (setupMasterKey)
 *   'recovery'   — restored from, or minted alongside, a family recovery phrase
 *   'device'     — provisioned by this device on first launch, before it knew
 *                  about any family. It encrypts only this device's own data.
 *
 * The join flow needs the distinction: a 'device' key is NOT the family's key,
 * so an invitee holding one still has to enter the family's recovery phrase.
 *
 * @returns The provenance tag, or null if no key is stored.
 */
export async function getMasterKeyType(): Promise<string | null> {
  await ensureReady();
  try {
    const stored = await secureStoreProxy.getItemAsync(SECURE_STORE_KEY_ALIAS);
    if (!stored) return null;
    const { type } = JSON.parse(stored);
    return type ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-tag the stored master key's provenance without changing the key itself.
 * Used by first-run provisioning, which mints its key through the recovery
 * path (so it is backed up) but must not masquerade as a family key.
 */
export async function setMasterKeyType(type: string): Promise<void> {
  await ensureReady();
  const stored = await secureStoreProxy.getItemAsync(SECURE_STORE_KEY_ALIAS);
  if (!stored) return;
  const envelope = JSON.parse(stored);
  envelope.type = type;
  await secureStoreProxy.setItemAsync(
    SECURE_STORE_KEY_ALIAS,
    JSON.stringify(envelope),
  );
}

/**
 * Clear the master key from secure storage (e.g. on family reset).
 */
export async function clearMasterKey(): Promise<void> {
  await secureStoreProxy.deleteItemAsync(SECURE_STORE_KEY_ALIAS);
}

/**
 * Encrypt the family master key with the voice assistant's RSA public key.
 */
export async function encryptMasterKeyWithAssistantPublicKey(
  masterKey: Uint8Array,
  publicKeyPem: string,
): Promise<string> {
  const webcrypto = require('isomorphic-webcrypto');
  await ensureReady();
  
  // 1. Strip headers and base64 decode SPKI DER bytes
  const base64 = publicKeyPem
    .replace(/-----BEGIN [\w ]+-----/g, '')
    .replace(/-----END [\w ]+-----/g, '')
    .replace(/\s/g, '');
  
  const derBytes = base64ToUint8Array(base64);

  // 2. Import SPKI public key
  const importedKey = await webcrypto.subtle.importKey(
    'spki',
    derBytes.buffer.slice(derBytes.byteOffset, derBytes.byteOffset + derBytes.byteLength),
    {
      name: 'RSA-OAEP',
      hash: { name: 'SHA-256' },
    },
    true,
    ['encrypt']
  );

  // 3. Encrypt the master key
  const ciphertextBuffer = await webcrypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    importedKey,
    masterKey
  );

  // 4. Return as base64 string
  return uint8ArrayToBase64(new Uint8Array(ciphertextBuffer));
}