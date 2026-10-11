/**
 * Relay Enrollment — obtains and stores a relay token.
 *
 * Flow:
 *  1. During invite-accept/pairing, call enrollWithRelay() with the
 *     device token and the family invite token obtained from QR/deep link.
 *  2. The relay returns a relayToken (opaque, 32-byte hex string).
 *  3. relayToken is stored in SecureStore and loaded on subsequent app starts.
 *  4. relayToken is passed to YjsWebSocketClient for auth on connect.
 *
 * If the relay token expires (default 30-day TTL with sliding window),
 * re-enrollment requires a fresh family invite from an existing member.
 */

import type { DeviceKeypair, RelayEnrollmentResponse } from '../types';
// expo-secure-store loaded lazily to avoid Hermes crash (chains to expo-asset at eval time)
let SecureStore: any = null;
async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}

const RELAY_TOKEN_ALIAS = 'groceryapp.relay_token';
const RELAY_URL_ALIAS = 'groceryapp.relay_url';

/**
 * Enroll this device with the relay server.
 * Must be called during the invite-accept/pairing flow.
 *
 * @param relayBaseUrl - Relay base URL (e.g. 'http://192.168.0.102:8080')
 * @param deviceToken - This device's opaque device token (base64 public key)
 * @param familyInviteToken - The invite token JSON string from QR/deep link
 * @param deviceKeypair - This device's keypair. When given, its Ed25519
 *   signing key is registered with the relay (with a proof of possession) so
 *   this device can issue invites the relay accepts.
 * @returns The relay token string.
 * @throws If enrollment fails (bad invite, server error, network).
 */
export async function enrollWithRelay(
  relayBaseUrl: string,
  deviceToken: string,
  familyInviteToken: string,
  deviceKeypair?: DeviceKeypair,
): Promise<string> {
  // Strip trailing slashes
  const baseUrl = relayBaseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/enroll`;
  let signing: { signingKey?: string; signingProof?: string } = {};
  if (deviceKeypair) {
    const { createEnrollmentSigningProof } = await import('./family');
    signing = await createEnrollmentSigningProof(deviceKeypair, JSON.parse(familyInviteToken), deviceToken);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      deviceToken,
      familyInviteToken,
      ...signing,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Enrollment failed (${res.status}): ${body}`);
  }

  const { relayToken } = (await res.json()) as RelayEnrollmentResponse;
  if (!relayToken) {
    throw new Error('Enrollment response missing relayToken');
  }

  // Persist atomically — write both, or clean up if either fails
  try {
    await (await getSecureStore()).setItemAsync(RELAY_TOKEN_ALIAS, relayToken);
    await (await getSecureStore()).setItemAsync(RELAY_URL_ALIAS, baseUrl);
  } catch (err) {
    // Partial write: clean up anything that was saved
    await (await getSecureStore()).deleteItemAsync(RELAY_TOKEN_ALIAS).catch(() => {});
    await (await getSecureStore()).deleteItemAsync(RELAY_URL_ALIAS).catch(() => {});
    throw new Error(
      `Failed to persist enrollment credentials: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return relayToken;
}

/**
 * Get the stored relay token (if any).
 * Returns null if not enrolled yet.
 */
export async function getRelayToken(): Promise<string | null> {
  try {
    return await (await getSecureStore()).getItemAsync(RELAY_TOKEN_ALIAS);
  } catch {
    return null;
  }
}

/**
 * Get the stored relay URL (if any).
 */
export async function getRelayUrl(): Promise<string | null> {
  try {
    return await (await getSecureStore()).getItemAsync(RELAY_URL_ALIAS);
  } catch {
    return null;
  }
}

/**
 * Clear stored relay credentials (e.g. on family leave or key rotation).
 */
export async function clearRelayCredentials(): Promise<void> {
  try {
    await (await getSecureStore()).deleteItemAsync(RELAY_TOKEN_ALIAS);
    await (await getSecureStore()).deleteItemAsync(RELAY_URL_ALIAS);
  } catch {
    // Best-effort cleanup — swallow errors since this is called during family leave
    // and the device may already be in a degraded state.
  }
}