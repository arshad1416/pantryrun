/**
 * Delete All Data — regression tests for the store-required deletion path.
 *
 * Both stores require an in-app way for users to erase their data. The wipe
 * (src/services/dataWipe.ts) must clear:
 *   - the WatermelonDB database,
 *   - every in-memory Yjs document,
 *   - the settings store,
 *   - every addressable groceryapp.* secure-store entry,
 * and delete groceryapp.master_key and the device keypair. SecureStore cannot
 * enumerate forgotten recovery/passkey entries; wiping known keys does not
 * guarantee forgotten entries or other family/relay copies become unreadable.
 *
 * UI wiring (confirmation dialog wording, destructive action) is pinned by
 * source scan in the suite's established idiom (no RN renderer here).
 *
 * Run: npx jest __tests__/delete-all-data.test.ts
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as SecureStore from 'expo-secure-store';
import { initCrypto, setMasterKey, getMasterKey } from '../src/crypto';
import { initDeviceIdentity, getDeviceKeypair, isDeviceInitialized } from '../src/identity/device';
import { ensureFamilyMembership, getFamilyId, getFamilyMembership } from '../src/identity/family';
import { initSettings, updateSettings } from '../src/config/settings';
import { getDatabase } from '../src/storage/database';
import { getDoc, getActiveDocIds } from '../src/sync/yjs-adapter';
import { deleteAllLocalData, type WipeResult } from '../src/services/dataWipe';
import { _getTable } from '../__mocks__/watermelondb';

const APP_ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');

// Every fixed-name groceryapp.* key the app writes (see dataWipe.ts header).
const FIXED_KEYS = [
  'groceryapp.master_key',
  'groceryapp.relay_token',
  'groceryapp.relay_url',
  'groceryapp.settings.cache',
  'groceryapp.device.settings_key',
  'groceryapp.family.membership',
  'groceryapp.passkey.supported',
  'groceryapp.device.secret_key',
  'groceryapp.device.public_key',
  'groceryapp.device.id',
];

// Prefix-keyed entries belonging to a family this device has "forgotten" —
// unreachable by any name-based wipe. They must SURVIVE (we cannot address
// them) while the keys that could ever decrypt them are destroyed.
const FOREIGN_KEYS = [
  'groceryapp.recovery.seed.zombie-family-id',
  'groceryapp.recovery.phrase.zombie-family-id',
  'groceryapp.passkey.credential.zombie-device-id',
];

describe('deleteAllLocalData()', () => {
  let familyId: string;
  let deviceId: string;
  let result: WipeResult;

  beforeAll(async () => {
    // ── Seed a fully-populated install ──────────────────────────────
    await initCrypto();
    deviceId = await initDeviceIdentity();
    await ensureFamilyMembership(getDeviceKeypair());
    familyId = (await getFamilyId())!;
    await setMasterKey(new Uint8Array(32).fill(7));
    await initSettings();
    await updateSettings({ flippFsa: 'L0R' } as any);
    await SecureStore.setItemAsync('groceryapp.relay_token', 'test-relay-token');
    await SecureStore.setItemAsync('groceryapp.relay_url', 'ws://192.168.1.10:8080');
    await SecureStore.setItemAsync('groceryapp.passkey.supported', 'true');
    await SecureStore.setItemAsync(`groceryapp.passkey.credential.${deviceId}`, '{"id":"cred"}');
    await SecureStore.setItemAsync(`groceryapp.recovery.seed.${familyId}`, 'seed-b64');
    await SecureStore.setItemAsync(`groceryapp.recovery.phrase.${familyId}`, 'twelve words …');
    await SecureStore.setItemAsync(`groceryapp.recovery.stored.${familyId}`, 'true');
    for (const key of FOREIGN_KEYS) {
      await SecureStore.setItemAsync(key, 'unreachable-residue');
    }

    // Database rows + a live Yjs doc.
    const db = getDatabase();
    await db.write(async () => {
      await db.get('grocery_lists').create((r: any) => {
        r._raw.id = 'list-1';
        r.name = 'enc-name';
      });
      await db.get('grocery_items').create((r: any) => {
        r._raw.id = 'item-1';
        r.name = 'enc-item';
      });
    });
    const doc = getDoc('list-1');
    doc.getMap('meta').set('name', 'plaintext-in-memory');
    expect(getActiveDocIds()).toContain('list-1');

    // ── Wipe ─────────────────────────────────────────────────────────
    result = await deleteAllLocalData();
  });

  it('completes every stage without errors', () => {
    expect(result.errors).toEqual({});
    expect(result.completed).toEqual(
      expect.arrayContaining([
        'disconnect-sync',
        'recovery-phrase',
        'passkeys',
        'master-key',
        'family-membership',
        'relay-credentials',
        'settings',
        'device-identity',
        'yjs-docs',
        'database',
        'memory-stores',
      ]),
    );
  });

  it('deletes every fixed-name groceryapp.* key', async () => {
    for (const key of FIXED_KEYS) {
      expect(await SecureStore.getItemAsync(key)).toBeNull();
    }
  });

  it('deletes the prefix-keyed entries for the CURRENT family and device', async () => {
    expect(await SecureStore.getItemAsync(`groceryapp.recovery.seed.${familyId}`)).toBeNull();
    expect(await SecureStore.getItemAsync(`groceryapp.recovery.phrase.${familyId}`)).toBeNull();
    expect(await SecureStore.getItemAsync(`groceryapp.recovery.stored.${familyId}`)).toBeNull();
    expect(await SecureStore.getItemAsync(`groceryapp.passkey.credential.${deviceId}`)).toBeNull();
  });

  it('cannot reach forgotten-family residue, but has destroyed every key that could use it', async () => {
    // The honest limitation: these survive because secure storage cannot
    // enumerate keys…
    for (const key of FOREIGN_KEYS) {
      expect(await SecureStore.getItemAsync(key)).toBe('unreachable-residue');
    }
    // …and the guarantee that makes that acceptable: the master key and the
    // device keypair are gone, so the residue is undecryptable garbage.
    expect(await SecureStore.getItemAsync('groceryapp.master_key')).toBeNull();
    expect(await SecureStore.getItemAsync('groceryapp.device.secret_key')).toBeNull();
    expect(await getMasterKey()).toBeNull();
    expect(isDeviceInitialized()).toBe(false);
  });

  it('resets the WatermelonDB database', () => {
    expect(_getTable('grocery_lists').size).toBe(0);
    expect(_getTable('grocery_items').size).toBe(0);
  });

  it('destroys every in-memory Yjs document', () => {
    expect(getActiveDocIds()).toEqual([]);
  });

  it('clears the cached family membership', async () => {
    expect(await getFamilyMembership()).toBeNull();
  });
});

describe('Delete All Data — UI wiring and policy text (source scan)', () => {
  it('does not promise key destruction when a wipe stage failed', () => {
    const src = read('src/screens/SettingsScreen.tsx');
    expect(src).not.toContain('Your encryption keys were destroyed, but');
    expect(src).toContain('Some local data or encryption keys may remain');
  });

  it('does not promise erasure of family or relay copies', () => {
    const src = read('src/screens/SettingsScreen.tsx');
    expect(src).not.toContain('can never be decrypted again');
    expect(src).toContain('does not erase copies on other family devices or your relay');
  });

  it('links to the reachable privacy and terms pages used by the store', () => {
    const src = read('src/screens/PrivacyScreen.tsx');
    expect(src).toContain("const PRIVACY_URL = 'https://www.pantryrun.app/privacy'");
    expect(src).toContain("const TERMS_URL = 'https://www.pantryrun.app/terms'");
  });

  it('SettingsScreen has a confirmed destructive Delete All Data action calling dataWipe', () => {
    const src = read('src/screens/SettingsScreen.tsx');
    expect(src).toContain("import('../services/dataWipe')");
    expect(src).toContain('deleteAllLocalData');
    expect(src).toContain('Delete All Data?');
    // The confirmation must say plainly that this is irreversible without
    // the recovery phrase — E2EE, no server-side reset.
    expect(src).toContain('UNRECOVERABLE');
    expect(src).toContain('recovery phrase');
    expect(src).toContain("style: 'destructive'");
  });

  it('privacy policy documents the wipe and forgotten-key limitation', () => {
    const html = read('privacy/index.html');
    expect(html).toContain('Delete All Data');
    expect(html).toContain('undecryptable');
    expect(html).toMatch(/cannot enumerate/i);
    expect(html).toContain('cannot guarantee');
    expect(html).toContain('This does not erase copies on other family devices or your relay');
  });
});
