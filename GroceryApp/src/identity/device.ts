/**
 * Device Identity — keypair generation and management.
 *
 * On first launch, generates a libsodium crypto_box keypair.
 * The secret key NEVER leaves the device.
 * The public key serves as the opaque device identifier (device token).
 *
 * Design:
 *  - Uses libsodium crypto_box_keypair for key generation
 *  - Secret key stored in expo-secure-store (never leaves device)
 *  - Device ID is base64-encoded public key
 *  - Supports key rotation via rotateDeviceKey()
 */

import { initCrypto, KeyReadError } from '../crypto/index';
// expo-secure-store loaded lazily to avoid Hermes crash (chains to expo-asset at eval time)
let SecureStore: any = null;
async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}
import type { DeviceKeypair } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEVICE_SECRET_KEY_ALIAS = 'groceryapp.device.secret_key';
const DEVICE_PUBLIC_KEY_ALIAS = 'groceryapp.device.public_key';
const DEVICE_ID_ALIAS = 'groceryapp.device.id';

const KEY_LENGTH_BYTES = 32; // crypto_box_PUBLICKEYBYTES / SECRETKEYBYTES

// ─── Caching ─────────────────────────────────────────────────────────────────

let cachedKeypair: DeviceKeypair | null = null;
let cachedDeviceId: string | null = null;

// ─── Internal Helpers ────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const sodium = require('react-native-libsodium');
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const sodium = require('react-native-libsodium');
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

async function generateNewKeypair(): Promise<DeviceKeypair> {
  const sodium = require('react-native-libsodium');
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  };
}

async function storeKeypair(kp: DeviceKeypair): Promise<void> {
  const deviceId = uint8ArrayToBase64(kp.publicKey);
  await (await getSecureStore()).setItemAsync(
    DEVICE_SECRET_KEY_ALIAS,
    uint8ArrayToBase64(kp.privateKey),
  );
  await (await getSecureStore()).setItemAsync(
    DEVICE_PUBLIC_KEY_ALIAS,
    uint8ArrayToBase64(kp.publicKey),
  );
  await (await getSecureStore()).setItemAsync(DEVICE_ID_ALIAS, deviceId);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize device identity. Must be called once at app startup.
 * On first launch, generates a new device keypair.
 */
export async function initDeviceIdentity(): Promise<string> {
  await initCrypto();
  console.log('[identity] Checking for stored device keypair…');

  // Check if we already have a keypair stored. A read that throws is not
  // "no keypair": generating one would replace this device's identity (and
  // its relay enrollment), so it surfaces as a KeyReadError — the startup
  // error screen offers Retry for it.
  let storedSecret: string | null;
  let storedPublic: string | null;
  try {
    storedSecret = await (await getSecureStore()).getItemAsync(DEVICE_SECRET_KEY_ALIAS);
    storedPublic = await (await getSecureStore()).getItemAsync(DEVICE_PUBLIC_KEY_ALIAS);
  } catch (err) {
    throw new KeyReadError('secure storage unavailable', err, 'device-identity');
  }

  if (storedSecret && storedPublic) {
    console.log('[identity] Found stored keypair, loading…');
    const publicKey = base64ToUint8Array(storedPublic);
    const privateKey = base64ToUint8Array(storedSecret);
    cachedKeypair = { publicKey, privateKey };
    cachedDeviceId = uint8ArrayToBase64(publicKey);
    console.log('[identity] ✓ Device ID loaded');
    return cachedDeviceId;
  }

  // First launch — generate new keypair
  console.log('[identity] No stored keypair — generating new one…');
  const kp = await generateNewKeypair();
  await storeKeypair(kp);
  cachedKeypair = kp;
  cachedDeviceId = uint8ArrayToBase64(kp.publicKey);
  console.log('[identity] ✓ New device keypair generated');
  return cachedDeviceId;
}

/**
 * Get the device ID (base64-encoded public key).
 */
export function getDeviceId(): string {
  if (!cachedDeviceId) {
    throw new Error('Device identity not initialized. Call initDeviceIdentity() first.');
  }
  return cachedDeviceId;
}

/**
 * Get the device keypair for signing operations.
 */
export function getDeviceKeypair(): DeviceKeypair {
  if (!cachedKeypair) {
    throw new Error('Device identity not initialized. Call initDeviceIdentity() first.');
  }
  return { ...cachedKeypair };
}

/**
 * Get the device public key as base64.
 */
export function getDevicePublicKey(): string {
  return uint8ArrayToBase64(getDeviceKeypair().publicKey);
}

/**
 * Get the device secret key as base64.
 */
export function getDeviceSecretKey(): string {
  return uint8ArrayToBase64(getDeviceKeypair().privateKey);
}

/**
 * Check if device identity has been initialized.
 */
export function isDeviceInitialized(): boolean {
  return cachedKeypair !== null && cachedDeviceId !== null;
}

/**
 * Rotate the device keypair — generates a new keypair and returns the new public key.
 * The old keypair is overwritten in secure store.
 * NOTE: This invalidates all existing family memberships; re-enrollment is required.
 */
export async function rotateDeviceKey(): Promise<string> {
  await initCrypto();
  const kp = await generateNewKeypair();
  await storeKeypair(kp);
  cachedKeypair = kp;
  cachedDeviceId = uint8ArrayToBase64(kp.publicKey);
  return cachedDeviceId;
}

/**
 * Clear device identity from secure store (for testing / factory reset).
 */
export async function clearDeviceIdentity(): Promise<void> {
  cachedKeypair = null;
  cachedDeviceId = null;
  await (await getSecureStore()).deleteItemAsync(DEVICE_SECRET_KEY_ALIAS);
  await (await getSecureStore()).deleteItemAsync(DEVICE_PUBLIC_KEY_ALIAS);
  await (await getSecureStore()).deleteItemAsync(DEVICE_ID_ALIAS);
}