/**
 * Typed settings store persisted to expo-secure-store.
 *
 * All sensitive values are encrypted using the device-specific crypto layer
 * (XChaCha20-Poly1305 with a device-derived key) before storage.
 *
 * Design:
 *  - A device-specific encryption key is derived once and cached in memory
 *  - Each setting is encrypted/decrypted individually with appropriate AAD context
 *  - Hosting tier controls which settings are visible/enabled in the UI
 *  - Defaults are provided for all settings
 */

import { initCrypto, encrypt, decrypt, generateUUID } from '../crypto/index';
// expo-secure-store loaded lazily to avoid Hermes crash (chains to expo-asset at eval time)
let SecureStore: any = null;
async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}
import type { AppSettings, HostingTier } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const SETTINGS_CACHE_KEY = 'groceryapp.settings.cache';
const DEVICE_SETTINGS_KEY = 'groceryapp.device.settings_key';
const SETTINGS_AAD_CONTEXT = 'app_settings';

/**
 * The PantryRun-operated relay (free). It is the same content-blind relay
 * self-hosters run (relay-server/), published at this hostname behind TLS —
 * see docs/deploy-hosted-relay.md. Port 443 is explicit so every call site
 * that joins `relayUrl` + `relayPort` (several append the port when the URL
 * carries none) produces a valid `wss://relay.pantryrun.app:443` /
 * `https://relay.pantryrun.app:443`, which is the default HTTPS port anyway.
 */
export const HOSTED_RELAY_URL = 'wss://relay.pantryrun.app';
export const HOSTED_RELAY_PORT = 443;

/**
 * What a self-hosted relay listens on (relay-server RELAY_PORT). Used when a
 * user switches from the hosted relay to self-hosted.
 */
export const SELF_HOSTED_RELAY_PORT = 8080;

/**
 * The pre-1.32 default. It never pointed at a working relay on a phone
 * (localhost is the phone itself), so an install still carrying it exactly is
 * migrated to the hosted relay once — see migrateLegacyRelayDefaultOnce.
 */
const LEGACY_DEFAULT_RELAY_URL = 'ws://localhost';
const LEGACY_DEFAULT_RELAY_PORT = 8080;

const DEFAULT_RELAY_URL = HOSTED_RELAY_URL;
const DEFAULT_RELAY_PORT = HOSTED_RELAY_PORT;
const DEFAULT_LOCAL_AI_ENDPOINT = 'http://localhost:1234';

const DEFAULT_SETTINGS: AppSettings = {
  // New installs sync through the PantryRun relay; self-hosting stays one
  // tap away in Settings → Hosting.
  hostingTier: 'managed',
  relayUrl: DEFAULT_RELAY_URL,
  relayPort: DEFAULT_RELAY_PORT,
  pairingCode: '',
  managedSubscriptionKey: '',
  localAiEndpoint: DEFAULT_LOCAL_AI_ENDPOINT,
  priceServiceEnabled: false,
  pricingOptedIn: false,
  voiceInputEnabled: false,
  barcodeScanningEnabled: false,
  flyerScanEnabled: true,
  cloudFlyerEnabled: false,
  contributeEnabled: false,
  contributeStoreGranularity: 'region',
  contributeConsentShown: false,
  recoveryPhraseAcknowledged: false,
  // Born migrated: a brand-new install has nothing to re-prompt about. Without
  // this, the one-shot below fires on the SECOND launch of a fresh install and
  // clears an acknowledgement the user had just given, for no reason.
  // Existing installs are unaffected — the migration reads the object loaded
  // from disk, which predates this default.
  recoveryPhraseWordlistReprompt: true,
  poolUrl: '',
  theme: 'system',
};

// ─── Cache ───────────────────────────────────────────────────────────────────

let settingsCache: AppSettings | null = null;
let deviceSettingsKey: Uint8Array | null = null;

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Get or create the device settings encryption key.
 * This is a separate key from the master encryption key, derived once and cached.
 */
async function getOrCreateSettingsKey(): Promise<Uint8Array> {
  if (deviceSettingsKey) return deviceSettingsKey;

  await initCrypto();
  try {
    const stored = await (await getSecureStore()).getItemAsync(DEVICE_SETTINGS_KEY);
    if (stored) {
      deviceSettingsKey = new Uint8Array(
        stored.split(',').map((s: string) => parseInt(s, 10)),
      );
      return deviceSettingsKey;
    }
  } catch (err) {
    console.warn('[settings] Failed to read device settings key, generating new one:', err);
  }

  // Generate a random key for device settings
  const sodium = require('react-native-libsodium');
  await sodium.ready;
  const key = sodium.randombytes_buf(32);
  deviceSettingsKey = key;
  try {
    await (await getSecureStore()).setItemAsync(DEVICE_SETTINGS_KEY, Array.from(key).join(','));
  } catch (err) {
    console.warn('[settings] Failed to persist device settings key:', err);
  }
  return key;
}

/**
 * Serialize settings to a JSON string, encrypt it, and store in secure store.
 */
async function persistSettings(settings: AppSettings): Promise<void> {
  const key = await getOrCreateSettingsKey();
  const serialized = JSON.stringify(settings);
  const encrypted = await encrypt(serialized, key, SETTINGS_AAD_CONTEXT);
  try {
    await (await getSecureStore()).setItemAsync(SETTINGS_CACHE_KEY, JSON.stringify(encrypted));
  } catch (err) {
    console.warn('[settings] Failed to persist settings:', err);
  }
  settingsCache = { ...settings };
}

/**
 * Load settings from secure store, decrypt, and cache.
 */
async function loadSettingsFromStore(): Promise<AppSettings | null> {
  try {
    const stored = await (await getSecureStore()).getItemAsync(SETTINGS_CACHE_KEY);
    if (!stored) return null;

    const key = await getOrCreateSettingsKey();
    const encrypted = JSON.parse(stored);
    const decrypted = await decrypt(encrypted, key, SETTINGS_AAD_CONTEXT);
    return JSON.parse(decrypted) as AppSettings;
  } catch (e) {
    console.error('[settings] loadSettingsFromStore error:', e);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip removed Turso fields from a settings object loaded from disk.
 * The turso URL/token fields are credentials and must not survive on device;
 * the turso enabled flag is the switch that activated them. All were removed
 * from AppSettings for v1 (see GOAL_PROMPT_NOTES.md, Option B decision), so
 * every `turso*` key is purged. Returns true if anything was stripped, so
 * the caller knows to re-persist the cleaned object.
 */
function stripRemovedFields(settings: Record<string, unknown>): boolean {
  let stripped = false;
  for (const key of Object.keys(settings)) {
    if (key.startsWith('turso')) {
      delete settings[key];
      stripped = true;
    }
  }
  return stripped;
}

/**
 * One-shot: re-prompt users to write down their recovery phrase, because the
 * words they already wrote down no longer work.
 *
 * Every phrase produced before the BIP39 wordlist was corrected encodes
 * against a 2042-word list that shared only 401 of 2048 positions with the
 * real one, so no build will accept those words back. The seed was always
 * intact, so getStoredRecoveryPhrase now derives a correct phrase — but a
 * user who already tapped "I've Stored It Safely" never sees the banner again
 * (HomeScreen.tsx:173) and would never learn their backup is dead paper.
 *
 * Clearing the acknowledgement is the whole fix: the banner reappears once,
 * they look, they copy the new words. Guarded by its own marker so it happens
 * exactly once and a user who re-acknowledges is not nagged forever.
 *
 * Returns true if anything changed, so the caller re-persists.
 */
function resetRecoveryAcknowledgementOnce(settings: Record<string, unknown>): boolean {
  if (settings.recoveryPhraseWordlistReprompt === true) return false;
  settings.recoveryPhraseWordlistReprompt = true;
  // Nothing to re-prompt if they never acknowledged in the first place — the
  // banner is already showing.
  if (settings.recoveryPhraseAcknowledged !== true) return true;
  settings.recoveryPhraseAcknowledged = false;
  return true;
}

/** Marker so the legacy-default migration below runs at most once. */
const HOSTED_RELAY_MIGRATION_KEY = 'hostedRelayDefaultMigrated';

/**
 * One-shot: move installs still on the old placeholder default
 * (`ws://localhost`, port 8080, self-hosted tier) to the hosted relay.
 *
 * Only the exact untouched default is migrated: any URL or port the user typed
 * — or that a scanned pairing code wrote — is left alone. The marker makes this
 * fire once, so a user who later deliberately points at ws://localhost (an
 * emulator dev setup) is not migrated again.
 *
 * Returns true if anything changed, so the caller re-persists.
 */
function migrateLegacyRelayDefaultOnce(settings: Record<string, unknown>): boolean {
  if (settings[HOSTED_RELAY_MIGRATION_KEY] === true) return false;
  settings[HOSTED_RELAY_MIGRATION_KEY] = true;
  const port = settings.relayPort ?? LEGACY_DEFAULT_RELAY_PORT;
  if (
    settings.relayUrl === LEGACY_DEFAULT_RELAY_URL &&
    port === LEGACY_DEFAULT_RELAY_PORT &&
    (settings.hostingTier ?? 'self_hosted') === 'self_hosted'
  ) {
    settings.relayUrl = HOSTED_RELAY_URL;
    settings.relayPort = HOSTED_RELAY_PORT;
    settings.hostingTier = 'managed';
  }
  return true;
}

/**
 * Initialize the settings store. Must be called once at app startup.
 * Loads settings from secure store into cache, or populates defaults.
 */
export async function initSettings(): Promise<AppSettings> {
  await initCrypto();
  console.log('[settings] Loading settings from secure store…');
  const loaded = await loadSettingsFromStore();
  if (loaded) {
    // Migration: purge Turso credentials persisted by earlier versions.
    const migrated = stripRemovedFields(loaded as unknown as Record<string, unknown>);
    // Re-prompt for the recovery phrase once: the old wordlist made every
    // previously written-down phrase undecodable.
    const reprompt = resetRecoveryAcknowledgementOnce(
      loaded as unknown as Record<string, unknown>,
    );
    // Move the old ws://localhost placeholder default to the hosted relay.
    const relayMigrated = migrateLegacyRelayDefaultOnce(
      loaded as unknown as Record<string, unknown>,
    );
    settingsCache = { ...DEFAULT_SETTINGS, ...loaded };
    if (migrated || reprompt || relayMigrated) {
      await persistSettings(settingsCache);
      if (migrated) console.log('[settings] ✓ Purged removed Turso fields from stored settings');
      if (reprompt) console.log('[settings] ✓ Recovery-phrase re-prompt armed (wordlist fix)');
    }
    console.log('[settings] ✓ Settings loaded (merged with defaults)');
    return { ...settingsCache };
  }

  // First launch — populate with defaults
  console.log('[settings] No stored settings — writing defaults…');
  await persistSettings(DEFAULT_SETTINGS);
  console.log('[settings] ✓ Default settings written');
  return { ...DEFAULT_SETTINGS };
}

/**
 * Get all current settings (from cache, no I/O).
 * Throws if settings haven't been initialized.
 */
export function getSettings(): AppSettings {
  if (!settingsCache) {
    throw new Error('Settings not initialized. Call initSettings() first.');
  }
  return { ...settingsCache };
}

/**
 * Get a single setting value.
 */
export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return getSettings()[key];
}

/**
 * Update one or more settings and persist.
 * Merges with existing settings.
 */
export async function updateSettings(
  partial: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = getSettings();
  const updated = { ...current, ...partial };
  await persistSettings(updated);
  return { ...updated };
}

/**
 * Set hosting tier (self_hosted | managed).
 * Validates that the tier value is correct.
 */
export async function setHostingTier(tier: HostingTier): Promise<AppSettings> {
  return updateSettings({ hostingTier: tier });
}

/**
 * Point this device at the PantryRun-hosted relay (tier + URL + port together).
 */
export async function selectHostedRelay(): Promise<AppSettings> {
  return updateSettings({
    hostingTier: 'managed',
    relayUrl: HOSTED_RELAY_URL,
    relayPort: HOSTED_RELAY_PORT,
  });
}

/**
 * Switch to self-hosting. A custom URL the user already entered is kept; the
 * hosted URL is cleared so the user is prompted for their own relay instead of
 * silently staying on ours.
 */
export async function selectSelfHostedRelay(): Promise<AppSettings> {
  const current = getSettings();
  const onHosted = current.relayUrl === HOSTED_RELAY_URL;
  return updateSettings({
    hostingTier: 'self_hosted',
    relayUrl: onHosted ? '' : current.relayUrl,
    relayPort: onHosted ? SELF_HOSTED_RELAY_PORT : current.relayPort,
  });
}

/**
 * Get the current hosting tier.
 */
export function getHostingTier(): HostingTier {
  return getSettings().hostingTier;
}

/**
 * Set the relay WebSocket URL.
 */
export async function setRelayUrl(url: string): Promise<AppSettings> {
  return updateSettings({ relayUrl: url });
}

/**
 * Set the relay port.
 */
export async function setRelayPort(port: number): Promise<AppSettings> {
  return updateSettings({ relayPort: port });
}

/**
 * Generate and set a pairing code for self-hosted setup.
 * The code is a JSON-encoded string containing deviceId, familyId, relayUrl.
 */
export async function setPairingCode(code: string): Promise<AppSettings> {
  return updateSettings({ pairingCode: code });
}

/**
 * Set the managed subscription key.
 */
export async function setManagedSubscriptionKey(
  key: string,
): Promise<AppSettings> {
  return updateSettings({ managedSubscriptionKey: key });
}

/**
 * Set local AI endpoint (self-hosted only).
 */
export async function setLocalAiEndpoint(
  endpoint: string,
): Promise<AppSettings> {
  return updateSettings({ localAiEndpoint: endpoint });
}

/**
 * Toggle opt-in features.
 */
export async function setPriceServiceEnabled(
  enabled: boolean,
): Promise<AppSettings> {
  return updateSettings({ priceServiceEnabled: enabled });
}

export async function setVoiceInputEnabled(
  enabled: boolean,
): Promise<AppSettings> {
  return updateSettings({ voiceInputEnabled: enabled });
}

export async function setBarcodeScanningEnabled(
  enabled: boolean,
): Promise<AppSettings> {
  return updateSettings({ barcodeScanningEnabled: enabled });
}

/**
 * Test connection to the relay server's /health endpoint.
 * Returns true if the server responds with 200.
 */
export async function testRelayConnection(
  url: string,
  port: number,
): Promise<boolean> {
  try {
    // Parse the URL properly — if URL already has a port, don't append another one
    let httpUrl = url
      .replace(/^ws:/, 'http:')
      .replace(/^wss:/, 'https:');
    
    // If URL doesn't already have a port, append the provided port
    let fullUrl: string;
    try {
      const parsed = new URL(httpUrl);
      if (parsed.port) {
        // URL already has a port, use it as-is
        fullUrl = `${httpUrl}/health`;
      } else {
        fullUrl = `${httpUrl}:${port}/health`;
      }
    } catch {
      // If URL parsing fails, fall back to simple append
      fullUrl = `${httpUrl}:${port}/health`;
    }
    
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reset all settings to defaults.
 */
export async function resetSettings(): Promise<AppSettings> {
  await persistSettings(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}

/**
 * Clear the settings cache and remove from secure store (for testing).
 */
export async function clearSettings(): Promise<void> {
  settingsCache = null;
  deviceSettingsKey = null;
  await (await getSecureStore()).deleteItemAsync(SETTINGS_CACHE_KEY);
  await (await getSecureStore()).deleteItemAsync(DEVICE_SETTINGS_KEY);
}