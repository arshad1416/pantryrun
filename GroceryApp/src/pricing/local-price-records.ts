/**
 * Local price records — the prices this device recorded itself (crowd
 * submissions from family members, flyer-scan extractions), persisted so
 * they survive an app restart.
 *
 * Encrypted at rest the same way settings are (config/settings.ts): one
 * random 32-byte device key in expo-secure-store, each record set sealed
 * with XChaCha20-Poly1305 using its storage alias as AAD, the sealed
 * envelope written to expo-secure-store. Item names, stores and prices never
 * touch storage in plaintext.
 *
 * Secure-store values are kept small (some platforms reject large values),
 * so an envelope is written in chunks: `<alias>.n` holds the chunk count and
 * `<alias>.<i>` the pieces. A torn or undecryptable set reads back as empty
 * (and says so in the log) rather than throwing.
 *
 * clearLocalPriceRecords() removes every chunk and the key; the price
 * store's clearPrices() — used by "Clear Local Prices" and "Delete All
 * Data" — calls it.
 */

import { initCrypto, encrypt, decrypt } from '../crypto/index';

let SecureStore: any = null;
async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}

/** Secure-store aliases of each record set. */
export const LOCAL_PRICE_ALIASES = {
  crowd: 'groceryapp.prices.crowd',
  flyerScan: 'groceryapp.prices.flyer_scan',
} as const;
export type LocalPriceAlias = (typeof LOCAL_PRICE_ALIASES)[keyof typeof LOCAL_PRICE_ALIASES];

const KEY_ALIAS = 'groceryapp.prices.local_key';
/** Characters per secure-store value (well under the 2 KB some platforms allow). */
const CHUNK_CHARS = 1800;

let cachedKey: Uint8Array | null = null;
/** Writes per alias run one after another so chunks never interleave. */
const writeChains = new Map<string, Promise<void>>();

async function getOrCreateKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  await initCrypto();
  const ss = await getSecureStore();
  const stored = await ss.getItemAsync(KEY_ALIAS);
  if (stored) {
    cachedKey = new Uint8Array(stored.split(',').map((s: string) => parseInt(s, 10)));
    return cachedKey;
  }
  const sodium = require('react-native-libsodium');
  await sodium.ready;
  const key: Uint8Array = sodium.randombytes_buf(32);
  await ss.setItemAsync(KEY_ALIAS, Array.from(key).join(','));
  cachedKey = key;
  return key;
}

async function writeRecords(alias: LocalPriceAlias, records: unknown[]): Promise<void> {
  const key = await getOrCreateKey();
  const envelope = JSON.stringify(await encrypt(JSON.stringify(records), key, alias));
  const ss = await getSecureStore();
  const previous = parseInt((await ss.getItemAsync(`${alias}.n`)) ?? '0', 10) || 0;
  const count = Math.ceil(envelope.length / CHUNK_CHARS);
  for (let i = 0; i < count; i++) {
    await ss.setItemAsync(`${alias}.${i}`, envelope.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
  }
  await ss.setItemAsync(`${alias}.n`, String(count));
  for (let i = count; i < previous; i++) await ss.deleteItemAsync(`${alias}.${i}`);
}

/** Persist a record set (replacing what was stored). Never throws. */
export function saveLocalPriceRecords(alias: LocalPriceAlias, records: unknown[]): Promise<void> {
  const prior = writeChains.get(alias) ?? Promise.resolve();
  const next = prior
    .then(() => writeRecords(alias, records))
    .catch((err) => console.warn(`[prices] couldn't save local prices (${alias}):`, err instanceof Error ? err.message : err));
  writeChains.set(alias, next);
  return next;
}

/** Read a record set back; empty when nothing (readable) is stored. */
export async function loadLocalPriceRecords<T>(alias: LocalPriceAlias): Promise<T[]> {
  try {
    await (writeChains.get(alias) ?? Promise.resolve());
    const ss = await getSecureStore();
    const count = parseInt((await ss.getItemAsync(`${alias}.n`)) ?? '0', 10) || 0;
    if (count === 0) return [];
    let envelope = '';
    for (let i = 0; i < count; i++) {
      const part = await ss.getItemAsync(`${alias}.${i}`);
      if (part === null) throw new Error('missing chunk');
      envelope += part;
    }
    const key = await getOrCreateKey();
    const parsed = JSON.parse(await decrypt(JSON.parse(envelope), key, alias));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.warn(`[prices] couldn't read local prices (${alias}):`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Delete stored record sets — all of them (and the key that sealed them) by
 * default, or just the given aliases.
 */
export async function clearLocalPriceRecords(aliases?: LocalPriceAlias[]): Promise<void> {
  const ss = await getSecureStore();
  for (const alias of aliases ?? Object.values(LOCAL_PRICE_ALIASES)) {
    await (writeChains.get(alias) ?? Promise.resolve()).catch(() => {});
    const count = parseInt((await ss.getItemAsync(`${alias}.n`)) ?? '0', 10) || 0;
    for (let i = 0; i < count; i++) await ss.deleteItemAsync(`${alias}.${i}`);
    await ss.deleteItemAsync(`${alias}.n`);
  }
  if (!aliases) {
    await ss.deleteItemAsync(KEY_ALIAS);
    cachedKey = null;
  }
}
